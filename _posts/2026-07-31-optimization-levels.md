---
layout: post
title: "Compiler Optimization Levels: What Actually Changes from -O0 to -O3"
date: 2026-07-31
domain: compiler
permalink: /blog/compiler/optimization-levels/
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7488460908818751489-LHzD/"
---

Two builds of the exact same code, one at `-O2`, one at `-O3`. The `-O3` build can run slower. Not because something broke. Because the compiler took a bet, and this time it lost. Understanding why requires looking at what each level actually enables and where the thresholds move.

## What Each Level Actually Does

The levels are not a continuous dial from "slow" to "fast." Each one is a named set of optimization passes with specific tradeoffs. The best way to see what changes between any two levels is to ask the compiler directly:

```bash
gcc -Q --help=optimizers -O2 > o2.txt
gcc -Q --help=optimizers -O3 > o3.txt
diff o2.txt o3.txt | grep enabled
```

The output lists every pass and whether it is enabled or disabled. The diff shows exactly what changed. This is more reliable than documentation, since documentation can lag behind what a specific compiler version actually does.

**`-O0`** is the no-optimization build. The compiler keeps variables in memory rather than registers wherever possible so that a debugger can find every variable at its declared location at any point in execution. Every expression is evaluated in the order written. Nothing is moved, combined, or eliminated. The result is slow but maximally debuggable.

**`-O1`** is the first meaningful optimization level. It enables a handful of passes: basic dead code elimination, some register allocation, simple constant propagation, and a few loop transformations. It avoids anything that significantly increases compile time or code size.

**`-O2`** is where most production C++ ships. It adds 54 passes over `-O1` (per the diff). The passes that matter most in practice: aggressive inlining, loop invariant code motion, strength reduction, alias analysis for better load/store scheduling, and strict aliasing assumptions that allow more reordering. `-O2` also pads function entry points, loop starts, and jump targets to 16-byte boundaries by default (`-falign-functions`, `-falign-loops`, `-falign-jumps`), spending bytes to keep the instruction fetch unit happy.

**`-O3`** adds 14 passes over `-O2`. The number is smaller than most people expect, which makes the level sound incremental. It is not. The specific passes it adds include `-fpeel-loops` (unrolling the first few iterations of a loop to avoid branch overhead), `-fpredictive-commoning` (optimizing repeated patterns across loop iterations), `-fipa-cp-clone` (cloning functions with constant arguments for specialization), and `-floop-interchange` (reordering nested loops for better cache access patterns). But the most consequential change between `-O2` and `-O3` is not a pass being added: it is a threshold moving.

**`-Og`** is the level most people skip. It is designed for the edit-compile-debug cycle: enough optimization to surface performance-related bugs that only appear at higher optimization levels, but not so much that the debugger loses track of variables. It is a better default than `-O0` for debug builds.

**`-Os`** optimizes for binary size. It runs most of `-O2`'s passes then reverses any that trade bytes for speed. Alignment padding is the clearest example: the 16-byte alignment that `-O2` adds to function entries and loop starts costs space whose only benefit is fetch throughput. `-Os` disables all of that. The diff between `-Os` and `-O2` shows 134 passes that differ in enabled status, making it the level that diverges most from the `-O2` baseline.

**`-Ofast`** enables `-O3` and then adds `-ffast-math`, which allows the compiler to break IEEE 754 floating-point semantics. It can reorder floating-point operations, assume inputs are never NaN or Inf, and use faster but slightly less accurate approximations. The results are often measurably faster for compute-heavy workloads but can produce wrong values for code that depends on exact floating-point behavior.

## The -fvect-cost-model Threshold

The most important difference between `-O2` and `-O3` is a flag that does not add a new pass at all: it moves a threshold on an existing one.

`-fvect-cost-model` controls how confident the compiler must be that vectorizing a loop will be profitable before it does so. There are four values:

- **`none`**: never vectorize
- **`very-cheap`**: vectorize only when the benefit is near-certain and the cost is negligible (the `-O2` default)
- **`cheap`**: vectorize when the benefit is likely but requires some overhead
- **`dynamic`**: vectorize even when uncertain, generating a runtime check to decide at execution time whether the vectorized path is faster (the `-O3` default)
- **`unlimited`**: vectorize regardless of cost

At `-O2`, the compiler uses `very-cheap`. It will vectorize a simple loop over a large array of floats with obvious independence between iterations because the gain is certain and the overhead is nothing. It will not vectorize a loop where there might be aliasing between the input and output pointers, because it cannot prove the gain is safe without emitting a runtime check.

At `-O3`, the model switches to `dynamic`. The compiler is now willing to generate two versions of a loop: a vectorized version and a scalar fallback. At runtime, it checks the relevant conditions (pointer alignment, aliasing, trip count) and branches to whichever path applies. This adds code size and adds a branch before every loop that was not worth vectorizing under `very-cheap`. On a workload where the vectorized path is always taken and the work per iteration is heavy enough to amortize the overhead, this wins. On a workload with short loops, unpredictable aliasing, or where the scalar path is taken often, the overhead of the runtime check and the extra code size outweigh the benefit.

This is why `-O3` can be slower than `-O2`. The bet is on vectorization being profitable. When it is not, you pay for the check and the extra code size with nothing in return.

## Inspecting the Full Flag List

The LinkedIn code snippet runs the actual diff:

```bash
$ gcc -Q --help=optimizers -O1 > o1.txt
$ gcc -Q --help=optimizers -O2 > o2.txt
$ gcc -Q --help=optimizers -O3 > o3.txt
$ gcc -Q --help=optimizers -Os > os.txt
$ diff o1.txt o2.txt | grep -c enabled
54
$ diff o2.txt o3.txt | grep -c enabled
14
$ diff os.txt o2.txt | grep -c enabled
134
$ diff os.txt o3.txt | grep -c enabled
24
```

The numbers: 54 new passes going from `-O1` to `-O2`, confirming that `-O2` is where most of the meaningful optimization work happens. Only 14 going from `-O2` to `-O3`, which is why the `-O3` behavior is so dominated by threshold changes rather than entirely new work. 134 passes differ between `-Os` and `-O2`, the largest gap of any pair here, because `-Os` is not a subset of `-O2` but a different optimization goal entirely: it enables some passes `-O2` does not (size-reduction specific transformations) while disabling many that `-O2` relies on. 24 differ between `-Os` and `-O3`, the intersection being narrower since `-O3`'s vectorization-heavy additions are exactly the kind of size-increasing optimizations `-Os` avoids.

Running this on your own compiler is more useful than reading documentation. The exact set of enabled passes differs between GCC versions, and checking against the version in your build system tells you what that binary is actually doing.

## Inlining: The Biggest Hidden Knob

Inlining is the optimization with the most leverage and the most impact on everything else. An inlined function call eliminates the call overhead, exposes the callee's code to the caller's context for further optimization, and can turn a virtual dispatch into a direct call or even remove it entirely.

Both `-O2` and `-O3` inline, but they use different cost thresholds. The parameters controlling this, `--param inline-unit-growth`, `--param max-inline-insns-single`, and several others, determine how large a function can be before the compiler stops inlining it. `-O3` raises these thresholds relative to `-O2`, allowing more aggressive inlining. More inlining means larger compilation units, more work for subsequent passes, and potentially better optimization at the cost of compile time and binary size.

Inlining can also hurt performance when a function inlined at many call sites bloats the instruction cache. A function that is called from 50 different places and is small on its own becomes 50 copies of the same code spread across the binary, evicting other instructions from the I-cache. Whether inlining helps or hurts depends on the specific call pattern, and the compiler's static analysis cannot always predict which way it goes.

## LTO: A Different Axis

Link-time optimization (`-flto`) is a separate mechanism from the `-O` levels. A normal compilation optimizes each translation unit in isolation: the compiler sees one `.cpp` file at a time and makes decisions based only on what is visible in that file. `extern` functions, templates instantiated elsewhere, and functions from other translation units are treated as black boxes.

`-flto` defers the final optimization until link time, when all translation units are combined. The linker then runs an optimization pass that can see the entire program at once: it can inline across translation unit boundaries, eliminate functions that are never called globally, propagate constants through function calls that would be opaque at compile time, and devirtualize virtual calls whose targets are only knowable with whole-program visibility.

`-flto` can be combined with any `-O` level. `-O2 -flto` applies `-O2` optimizations within each translation unit and then performs whole-program optimization at link time. The compile time cost is significant since the link step now does optimization work proportional to the entire program, but the resulting binary often outperforms `-O3` without LTO on programs with significant cross-unit call patterns.

## PGO: Letting the Runtime Decide

Static optimization, every level from `-O1` to `-O3`, makes decisions based on what the compiler can infer from source code alone. It can see that a branch exists, but it cannot know that branch is taken 99% of the time in production. It can see that a function is called, but it cannot know it is on the hot path for your specific workload. Every threshold in the cost model is a guess calibrated against general code, not your code.

Profile-Guided Optimization (PGO) closes that gap. The process has three steps:

**Step 1**: Compile with instrumentation enabled. The compiler inserts counters at branches, function entries, and indirect call sites.

```bash
# GCC
g++ -O2 -fprofile-generate -o myapp myapp.cpp

# Clang
clang++ -O2 -fprofile-instr-generate -o myapp myapp.cpp
```

**Step 2**: Run the instrumented binary against a representative workload. Every branch taken, every function called, every indirect dispatch is counted and written to a profile file.

```bash
./myapp < representative_workload.txt
# GCC writes .gcda files
# Clang writes default.profraw
```

**Step 3**: Recompile using the profile data. The compiler now knows which branches are hot, which functions are called frequently, which loops run few or many iterations.

```bash
# GCC
g++ -O2 -fprofile-use -o myapp_pgo myapp.cpp

# Clang: merge first, then compile
llvm-profdata merge -output=myapp.profdata default.profraw
clang++ -O2 -fprofile-instr-use=myapp.profdata -o myapp_pgo myapp.cpp
```

What the compiler does with this data changes almost every optimization decision. Branch prediction hints are annotated so the CPU's own predictor gets the right bias on the first encounter. Hot call sites get inlined even if they exceeded the static inlining threshold, and cold call sites that would have been inlined under `-O3`'s aggressive thresholds are left as calls to avoid bloating the I-cache. Hot functions get grouped together in the binary's `.text` section so they share cache lines. Loop optimizations get actual trip count estimates instead of conservative guesses.

The catch is the training data problem. PGO optimizes for the workload you profiled against. Code paths not covered by the training run are treated as cold and may be moved to cold sections, have branches mis-annotated, or get deoptimized in other ways. If your training run is not representative of production, PGO can make performance worse on the paths it missed while improving the paths it saw. The quality of the profile data is the entire constraint.

In practice, PGO typically delivers 10 to 20 percent improvement on real workloads, sometimes more for branch-heavy or call-intensive code. Google, Meta, and most browser vendors use PGO in production builds. Chrome's build process runs a training workload, generates profile data, and then produces the final binary from that data on every release. The gains are large enough to be worth the build complexity.

**AutoFDO** is a variant that avoids the instrumentation step. Instead of a specially compiled binary, it uses sampling data from Linux `perf` on a production build. The `perf` data is converted to a profile the compiler can use, giving PGO-like optimization from production traffic instead of a synthetic training run. The profile is less precise than full instrumentation but it reflects what production actually does, which is often better than what a test harness does.

## When to Use Each Level

**For debug builds**: `-Og`. Better than `-O0` for finding real bugs, still debuggable.

**For production**: `-O2`. The safe default. Well-understood behavior, no speculation, what most of the ecosystem ships with.

**For `-O3`**: only when you have measured, on the specific workload that matters, that `-O3` is faster than `-O2` for your binary. The vectorization bet is worth nothing if your loops are short or your working set is aliasing-heavy. Profile at `-O2` first, identify the hot loops, then check whether `-O3` helps those specific paths.

**For size-constrained targets**: `-Os`. Embedded firmware, bootloaders, any context where binary size has a hard limit.

**For floating-point intensive compute**: consider `-O2 -ffast-math` explicitly rather than `-Ofast`, so the dangerous relaxation is a deliberate choice per file rather than a blanket flag.

**For whole-program optimization**: add `-flto` to whatever `-O` level you already use. The compile-time cost is worth measuring, but the performance gains on real programs with cross-unit calls are often larger than any single `-O` level change.

**For maximum performance on a known workload**: combine `-O2 -flto` with PGO. The three together (static optimization, whole-program visibility, and runtime profile data) cover different sources of information about your code and their gains are largely additive.

## Quick Reference

**Coming from other languages**

Most compiled languages expose fewer optimization knobs than GCC and Clang. Rust's `--release` corresponds roughly to `-O2` with LTO. Go's compiler does not expose explicit optimization levels. The reason C++ exposes this granularity is partly historical (the flags accrued over decades) and partly intentional (systems code often needs control over exactly what transformations happen to critical loops). The tradeoff is that the programmer has to understand what the flags actually do to use them correctly, which is why running the optimizer flag dump and diff directly is worth doing at least once on any project that is performance-sensitive.

**The 90% mental model**

`-O0` keeps everything in place for debuggers. `-O2` is where production optimization happens: 54 passes over `-O1`, inlining, register allocation, constant folding, loop optimizations, and alignment padding. `-O3` adds 14 more passes and changes one critical threshold: the vectorization cost model moves from `very-cheap` to `dynamic`, allowing the compiler to generate runtime-checked speculative vectorization. That single threshold shift is why `-O3` can be slower on workloads where the vectorization bet loses. `-Os` differs from `-O2` by 134 pass settings in total, removing everything that spends bytes to buy speed. Use `-O2` as the default, reach for `-O3` only when profiling confirms the specific workload benefits, add `-flto` separately when cross-unit optimization matters, and add PGO on top of both when you have a representative training workload: instrument, run, recompile. PGO gives the compiler runtime knowledge no static analysis can match.
