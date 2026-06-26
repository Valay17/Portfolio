---
layout: post
title: "Branch Prediction: the Cost Is the Flush, Not the Branch"
date: 2026-06-26
domain: cpu
permalink: /blog/cpu/branch-prediction/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/cpu/branch-prediction"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

When a CPU mispredicts a branch, it does not just pause and wait. It already ran the wrong instructions, and now has to throw all of that work away. The branch itself is nearly free. The cleanup afterward is not.

## Why CPUs Predict at All

Modern CPUs do not wait to know which way a branch goes before doing anything. The frontend predicts the outcome and speculatively executes down that path before the condition is even resolved. If the guess is right, that is free work done early, instructions executed during what would otherwise have been idle time waiting on the branch condition. If the guess is wrong, the CPU has to flush the pipeline: discard everything computed on the wrong path and restart from the correct branch. A pipeline flush at the end of a misprediction is itself counted as a branch miss, the visible cost of having guessed wrong. That flush is the actual cost being paid here, not the branch instruction itself.

This only matters because modern CPUs are pipelined and look ahead. A simple, unpipelined CPU executing one instruction fully before starting the next would have no need to guess, it would just wait for the branch condition and then proceed. Pipelining is what makes prediction necessary in the first place, and it is also what makes a wrong guess expensive, since a wrong guess means discarding however many pipeline stages of work were already in flight down the wrong path.

## Frontend and Backend, and Where Prediction Lives

A CPU core's work splits into two broad halves, and where branch prediction sits between them explains why a misprediction is disruptive in a specific way rather than just "slow."

The frontend handles fetch, decode, branch prediction, and dispatch into the instruction queue, getting instructions ready to execute. The backend is where actual execution, the real computation, happens, along with retiring completed instructions and writing results back. If the frontend cannot keep the backend supplied with instructions fast enough, the backend starves, sitting idle waiting for work. This specific failure mode is called frontend bound: the backend has capacity to do more work, but the frontend is not feeding it fast enough, commonly due to branch mispredictions or instruction cache misses. The mirror case, backend bound, happens when the frontend is supplying instructions fine but the backend is stuck waiting on something else entirely, data cache misses, dependency chains, or memory access, none of which branch prediction has anything to do with.

A branch misprediction is a frontend problem specifically. The frontend's branch predictor, working alongside a branch target buffer that tracks where branches have gone before, decides which way to send the fetch unit down a branch before the condition is actually known. Get that wrong, and the instructions the frontend already fed into the pipeline have to be discarded, which is exactly the flush described above. The fetch unit and predictor are also responsible for a related kind of guessing for function returns, tracked by a separate structure called a return address stack, predicting where execution should resume after a function call returns, the same general idea as branch prediction but specific to call and return rather than conditional branches.

Branch prediction and return address prediction are both specific cases of a broader pattern called speculative execution: the CPU proceeding ahead of confirmed state, on the bet that the bet pays off more often than not, and rolling back the work if it does not. Branches are the most visible case because they happen constantly in ordinary code, but the same principle shows up elsewhere too, speculative loads that guess at a memory address before a preceding computation has fully resolved it, for example. The cost structure is identical everywhere this pattern shows up: a correct guess is free work done early, a wrong guess means discarding whatever was computed speculatively and resuming from the confirmed state. Branch misprediction is simply the instance of this pattern that shows up most often and is easiest to measure directly.

## Prediction Is Not a Fresh Guess Every Time

The predictor is not flipping a coin on every branch it encounters. There is dedicated hardware behind this. The `Branch Target Buffer(BTB)` tracks where specific branches have gone before, and a separate predictor component learns patterns over repeated passes through the same code. A loop with a consistent direction, taken every iteration except the last, gets predicted well almost immediately, since the same branch resolves the same way over and over and the hardware learns that pattern fast. A branch on unpredictable data, checking whether a random number is even or odd, gets predicted close to a coin flip, since there is no pattern underneath for the hardware to learn.

This learning process is sometimes described as training the predictor. It comes with a limitation worth stating directly: this is purely hardware, learning purely from runtime behavior, and there is no way to deterministically command it from source code. You can shape code so that it tends to train well, structuring a hot loop so its branches resolve consistently, but there is no instruction that says predict this branch as taken from now on and have the hardware obey it unconditionally. The predictor still adapts to whatever actually happens at runtime, regardless of what the code's structure suggests it should do. It is an opaque piece of hardware, and the accurate framing is that source-level changes can nudge it, sometimes effectively, but never fully control it.

## What [[likely]] and [[unlikely]] Actually Do

`[[likely]]` and `[[unlikely]]` look like they talk to the branch predictor directly. They do not. The predictor learns purely from runtime behavior. Nothing written in source code reaches that hardware directly.

```cpp
volatile int sink;

int classify(int x) {
    if (x > 0) {
        sink = 1;
        return 1;
    } else [[likely]] {
        sink = 2;
        return -1;
    }
}
```

`[[likely]]` does not reach the branch predictor. It tells the compiler which path to lay out as the straight-line fallthrough and which to push out of line behind a jump, a layout choice that can help prediction indirectly, not an instruction to the hardware predictor itself.

A write to a `volatile` location cannot be optimized away, since the compiler has to assume something outside its visibility might depend on that write actually happening, the same property that gives `volatile` its narrow but real use case for hardware registers covered in an earlier post. That side effect on each branch is what keeps the if/else alive as a real branch in the generated code, rather than letting the compiler collapse it into branchless arithmetic the way it would for a function that just returns a constant on each path.

## What the Code Demonstrates

### branch-cost.cpp: Isolating Misprediction From Memory Effects

The usual demo for this topic is a sorted versus unsorted array, summing only the values that pass some condition. That demo is deliberately avoided here, because sorting an array changes its access pattern implications in ways that can tangle branch effects together with cache effects, making it harder to say with confidence which one is responsible for an observed slowdown.

Both modes here allocate an array of the same size, fill it sequentially, and read it sequentially in the same order. Memory footprint and access pattern are identical between the two modes by construction. The only thing that differs between `predictable` and `random` is the value stored at each position, which controls which direction the branch takes at that position. Since cache behavior depends on access pattern and footprint, not on the actual values stored, any timing difference between the two modes can be attributed to branch prediction specifically, with memory effects controlled for.

### likely-codegen.cpp: Seeing the Layout Change Directly

`likely-codegen.cpp` is not run. It is compiled to assembly and inspected with `objdump`, comparing two versions of the same `classify` function: no attribute, and `[[likely]]` on the else branch. The goal is to see the actual code layout difference, not a runtime number, since the attribute's entire effect happens at compile time in how the code gets arranged.

Each version writes to a `volatile int` on both branches before returning. That write cannot be optimized away, since the compiler has to assume something outside its visibility might depend on it happening, which forces the if/else to survive as a real branch in the generated code. Without that anchor, a function this small is a strong candidate for the compiler eliminating the branch entirely, replacing the if/else with a single branchless instruction sequence and leaving no branch for a layout hint to apply to.

Look for the path landing as a straight fallthrough requiring no jump to reach, and the other path requiring an explicit jump, with that layout flipping depending on which branch carries `[[likely]]`.

## Run: branch-cost.cpp

Compile once:

```bash
g++ -O2 -std=c++20 branch-cost.cpp -o branch-cost
```

`-O2` is the standard optimization level used across this repo.

Run each mode as its own process, separately:

```bash
./branch-cost predictable
./branch-cost random
```

Running these separately, rather than back to back in one process, keeps any state from one run from influencing the other, the same separation used for every other good versus bad comparison in this repo.

For a closer look at what the CPU is actually doing differently between the two runs:

```bash
perf stat -e branches,branch-misses,cycles,instructions ./branch-cost predictable
perf stat -e branches,branch-misses,cycles,instructions ./branch-cost random
```

`branches` and `branch-misses` together give the actual misprediction rate. Expect it to land low for the predictable run, since the predictor can learn a consistent pattern quickly. The random run's misprediction rate is not guaranteed to land near the 50 percent a true coin flip would produce. See the actual numbers below for what this run showed and why the rate came in lower than that ceiling.

`cycles` and `instructions` together give instructions-per-cycle, useful for seeing whether the two runs are spending cycles differently relative to the work they retire, not just differently in total.

## Run: likely-codegen.cpp

Compile to assembly, no execution:

```bash
g++ -O2 -std=c++20 -c likely-codegen.cpp -o likely-codegen.o
objdump -d -M intel --no-show-raw-insn likely-codegen.o
```

`-c` compiles to an object file without linking, since this file has no `main` and is not meant to run. `-M intel` selects Intel syntax over the default AT&T syntax. `--no-show-raw-insn` hides the raw instruction bytes, leaving just the mnemonics.

Compare `classify_no_hint` and `classify_likely` directly.

## Output

```
predictable: 26 ms, result = 100000000
random: 320 ms, result = 150006069
```

## perf stat output

```
 Performance counter stats for './branch-cost predictable':

       334,712,591      branches
         3,697,535      branch-misses
       524,107,788      cycles
     1,270,725,223      instructions

       0.122757276 seconds time elapsed

       0.073508000 seconds user
       0.049341000 seconds sys


 Performance counter stats for './branch-cost random':

     1,172,798,377      branches
        54,882,138      branch-misses
     4,453,674,591      cycles
    11,126,222,247      instructions

       1.051614218 seconds time elapsed

       0.997629000 seconds user
       0.052032000 seconds sys
```

The misprediction rate makes the difference concrete. The predictable run mispredicts 3.7 million times out of 334.7 million branches, a rate of roughly 1.1 percent, close to the near-zero expected for a branch pattern the predictor can learn. The random run mispredicts 54.9 million times out of 1.17 billion branches, close to 4.7 percent, well above the 50 percent ceiling a true coin flip would produce, which suggests the predictor is still picking up partial structure even on this input rather than failing completely. What matters more than the raw percentage is the absolute gap: 3.7 million mispredictions against 54.9 million, nearly 15 times as many flushes paid for in the random run.

The instructions-per-cycle numbers show where that cost actually lands. The predictable run retires roughly 2.42 instructions per cycle (1,270,725,223 instructions over 524,107,788 cycles). The random run retires roughly 2.50 instructions per cycle (11,126,222,247 over 4,453,674,591), close to the same IPC despite the heavier misprediction rate, because IPC here is dominated by the sheer instruction count difference between the two runs rather than isolating the cycles actually wasted on flushes. The real cost shows up directly in wall clock time instead: 26 ms for the predictable run against 320 ms for random, roughly 12 times slower for a loop doing the same shape of work on the same amount of data. That gap lines up with the cycle counts: 4.45 billion cycles against 524 million, also roughly 8.5 times more total CPU work, almost entirely attributable to flush overhead from the far higher number of mispredictions rather than to any difference in the actual arithmetic being performed.

## objdump output

```
0000000000000000 <_Z15classify_likelyi>:
   0:   mov    rax,QWORD PTR [rip+0x0]
   7:   test   edi,edi
   9:   jg     20 <_Z15classify_likelyi+0x20>
   b:   mov    DWORD PTR [rax],0x2
  11:   mov    eax,0xffffffff
  16:   xor    edi,edi
  18:   ret
  19:   nop    DWORD PTR [rax+0x0]
  20:   mov    DWORD PTR [rax],0x1
  26:   mov    eax,0x1
  2b:   xor    edi,edi
  2d:   ret
  2e:   xchg   ax,ax

0000000000000030 <_Z16classify_no_hinti>:
  30:   mov    rax,QWORD PTR [rip+0x0]
  37:   test   edi,edi
  39:   jle    50 <_Z16classify_no_hinti+0x20>
  3b:   mov    DWORD PTR [rax],0x1
  41:   mov    eax,0x1
  46:   xor    edi,edi
  48:   ret
  49:   nop    DWORD PTR [rax+0x0]
  50:   mov    DWORD PTR [rax],0x2
  56:   mov    eax,0xffffffff
  5b:   xor    edi,edi
  5d:   ret
```

The `volatile` write does its job. Both functions kept a real conditional jump in the generated code, no branch elimination here. The layout difference between the two functions is the actual point.

In `classify_likely`, the else branch carries `[[likely]]`, the `sink = 2; return -1;` path. That branch lands at offset `b`, immediately after the `test`, reached with no jump at all if `jg` is not taken. The unmarked `if (x > 0)` branch, the `sink = 1; return 1;` path, sits at offset `20`, reached only through the explicit `jg 20` jump. The path marked `[[likely]]` got the straight-line fallthrough position. The unmarked path got pushed behind a jump.

In `classify_no_hint`, with no attribute anywhere, the layout flips. The `if (x > 0)` branch is now the one sitting at the fallthrough position, offset `3b`, reached with no jump when `jle` is not taken. The else branch, the same `sink = 2; return -1;` code as before, is now the one reached through an explicit jump, `jle 50`. With no hint given, the compiler defaulted to treating the `if` branch as the one to fall through to, the opposite of what happened once `[[likely]]` was attached to the else branch instead.

This is the layout effect in full. The attribute did not touch the branch predictor, it changed which of the two paths the compiler chose to place as the cheap, no-jump fallthrough and which one it pushed behind an explicit jump, and moving the attribute from one branch to the other flipped that choice directly.

## Quick Reference

**Coming from other languages**

Branch prediction is hardware, sitting below any language entirely. Every language compiling down to native code on the same CPU is subject to the same predictor, the same branch target buffer, and the same flush cost on a wrong guess. Some languages and compilers expose their own version of likely/unlikely hinting for the same layout-level reason C++ does, and some do not expose it at all, leaving the compiler to infer layout heuristically. Either way, the hardware underneath never receives a hint from source code directly, regardless of which language produced that code.

**The 90% mental model**

A branch misprediction does not cost you the branch. It costs you a pipeline flush, throwing away whatever work was already done speculatively down the wrong path. Branches that follow a consistent pattern, loops, sorted data, predictable conditions, get predicted well almost for free. Branches on unpredictable data get predicted close to a coin flip, and there is no attribute or hint that changes that, since the predictor is hardware learning from runtime behavior, not something source code can command directly.
