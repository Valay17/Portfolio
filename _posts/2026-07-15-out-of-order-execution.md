---
layout: post
title: "Out-of-Order Execution: How the CPU and Compiler Reorder Your Code"
date: 2026-07-15
domain: cpu
permalink: /blog/cpu/out-of-order-execution/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/cpu/out-of-order-execution"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7483419388751278080-ZcY4/"
---

Your CPU does not run your code in the order you wrote it. It never promised to. The guarantee is that the result looks like it did, not that the execution happened that way.

## Why In-Order Execution Wastes Time

A simple in-order pipeline: fetch an instruction, decode it, execute it, write the result, move to the next instruction. The problem is that execution takes different amounts of time. A register add takes one cycle. A cache miss to DRAM takes hundreds. An in-order pipeline that has to wait for the slow instruction to finish before starting the next one leaves every other execution unit idle for hundreds of cycles. The theoretical throughput exists in the silicon; the in-order constraint throws it away.

Out-of-order execution solves this by decoupling the order instructions are fetched from the order they execute. The CPU fetches instructions in program order, then dispatches them into a pool of waiting slots. Each instruction waits there until its operands are ready, then fires to an available execution unit. Instructions that are ready execute immediately, even if earlier instructions in program order have not finished yet. The result looks the same from the outside, but the CPU was doing many things at once.

## Branch Prediction: the Frontend's Guess

The CPU's fetch unit fetches instructions from the instruction cache and feeds them to the decoder. To keep the out-of-order engine supplied with work, it needs to fetch far ahead of what is currently executing. Branches break this, since the next instruction to fetch depends on whether the branch is taken or not.

The branch predictor sits in the CPU's frontend and makes that guess before the branch instruction even reaches the execution stage. Two specialized structures help it:

The Branch Target Buffer (BTB) stores the predicted target address for branches the CPU has seen before. When the fetch unit encounters a branch, the BTB supplies the address to fetch from next, before the branch has been decoded or evaluated. The fetch unit jumps there immediately and keeps fetching.

The Return Address Stack (RAS) handles function returns specifically. When the CPU fetches a `call` instruction, it pushes the return address onto the RAS. When it fetches the corresponding `ret`, it pops from the RAS to predict where execution will return to. This is separate from the BTB because returns are structurally different from other branches: the target is always the address that was pushed when the call happened, which the BTB could not easily predict from history alone.

When the prediction is wrong, everything the CPU speculatively executed down the wrong path has to be thrown away. The ROB discards those entries, the physical registers allocated for them are released back to the renaming pool, and the fetch unit restarts from the correct address. This is a pipeline flush. The number of instructions thrown away is the pipeline depth times the issue width, on modern CPUs this can be dozens to over a hundred instructions worth of work discarded on a single misprediction.

The end-of-loop branch is the textbook case. The branch predictor learns the pattern over many iterations and predicts "taken" repeatedly. The last iteration is "not taken," breaking the learned pattern and costing a flush. This is visible in profiler output as branch mispredictions on the loop's back edge.

## The Compiler Does the Same Thing One Level Up

The hardware reorders instructions at runtime. The compiler reorders them at compile time, for the same reason: if two instructions have no dependency between them, there is no correctness reason to emit them in any particular order, and a different order might expose more parallelism to the hardware or reduce stalls from known instruction latencies.

```cpp
long a = slow_function(x);  // slow: takes many cycles
long b = y * 2 + 7;         // fast: no dependency on a
long result = a + b;
```

The compiler may emit the computation of `b` before the call to `slow_function`, or interleave the fast arithmetic between the call and the use of the result, since `b` does not depend on `a`. The single-threaded result is identical regardless of order. The hardware does the same thing again at runtime based on which instructions have their operands ready.

Both layers, compiler and hardware, operate under the same rule: reordering is permitted as long as no single thread can observe the difference. The moment a second thread is watching, the guarantee disappears. A second thread can observe loads and stores happening in orders that neither the source code nor the programmer assumed, because neither the compiler nor the hardware is required to preserve any cross-thread ordering without explicit synchronization.

## Calls vs Loads: A Hard Boundary vs a Hint

The compiler reordering described above, scheduling independent work around a slow operation, does not apply equally to all slow operations. There is a structural difference between a slow function call and a slow memory load, and it matters for whether any reordering happens at all.

A `call` instruction redirects control flow. Instructions physically located after a `call` in the binary are not fetched until the call returns. There is no instruction stream past the call for the compiler to schedule into or for the CPU to execute out of order. The compiler may schedule the computation of independent values before the call, but nothing after it can be moved before it, since the CPU does not even see those instructions until the call completes.

A load is not a control-flow instruction. The instructions that follow a load in the binary are fetched and dispatched immediately alongside the load. Both the compiler at compile time and the CPU at runtime are free to schedule independent work before, during, or after the load, since the load does not interrupt the instruction stream.

This distinction matters for how to read the LinkedIn post's own code snippet. `long a = slow_function(x)` only demonstrates the reordering it describes if `slow_function` is treated as a stand-in for a slow load. As a literal call to an external function, the compiler cannot schedule `b`'s computation before it, only after. The codegen confirms this directly.

```cpp
extern long slow_function(long x); // opaque to the compiler, never inlined

/* call is a hard control-flow boundary. Instructions after it are not
   fetched until the call returns. Nothing can be scheduled ahead of it. */
long compute_call(long x, long y, long z, long w) {
    long a = slow_function(x);
    long b = (y * 2 + 7) ^ (z * 3 - w) + (y & z) * (w | y);
    return a + b;
}

/* load is not a control-flow boundary. The compiler is free to schedule
   independent work before the load resolves. */
long compute_load(const long* arr, long x, long y, long z, long w) {
    long a = arr[x];
    long b = (y * 2 + 7) ^ (z * 3 - w) + (y & z) * (w | y);
    return a + b;
}
```

Identical `b` expression in both. The only variable is whether `a` comes from a call or a load.

## Run: codegen.cpp

```bash
g++ -O2 -std=c++20 -c codegen.cpp -o codegen.o
objdump -d -M intel --no-show-raw-insn codegen.o
```

`-c` compiles to an object file without linking since this file has no `main`. `-M intel` selects Intel syntax. `--no-show-raw-insn` hides raw instruction bytes.

In `compute_call`: expect every instruction computing `b` to appear after the `call`, not before it. Nothing after a call is fetched until it returns, so the compiler has no choice.

In `compute_load`: expect the opposite. Every instruction computing `b` should appear before the load of `a`, with the load itself as one of the last instructions before the return, likely fused directly into the final addition.

```
$ objdump -d -M intel --no-show-raw-insn codegen.o

0000000000000000 <compute_call(long, long, long, long)>:
   0:   push   rbp
   1:   mov    rbp,rsp
   4:   push   r13
   6:   mov    r13,rcx
   9:   push   r12
   b:   mov    r12,rdx
   e:   push   rbx
   f:   mov    rbx,rsi
  12:   sub    rsp,0x8
  16:   call   1b <compute_call(long, long, long, long)+0x1b>   <-- a requested here
  1b:   mov    rdx,rbx
  1e:   add    rsp,0x8
  22:   mov    rcx,rax
  25:   mov    rax,rbx
  28:   or     rdx,r13
  2b:   and    rax,r12
  2e:   imul   rax,rdx
  32:   lea    rdx,[r12+r12*2]
  36:   sub    rdx,r13
  39:   add    rax,rdx
  3c:   lea    rdx,[rbx+rbx*1+0x7]                             <-- all of b computed after the call
  41:   pop    rbx
  42:   pop    r12
  44:   xor    rax,rdx
  47:   pop    r13
  49:   pop    rbp
  4a:   add    rax,rcx                                          <-- a + b
  4d:   ret

0000000000000050 <compute_load(long const*, long, long, long, long)>:
  50:   mov    rax,rdx
  53:   mov    r9,rdx
  56:   lea    rdx,[rdx+rdx*1+0x7]
  5b:   and    rax,rcx
  5e:   or     r9,r8
  61:   lea    rcx,[rcx+rcx*2]
  65:   imul   rax,r9
  69:   sub    rcx,r8
  6c:   add    rax,rcx
  6f:   xor    rax,rdx                                          <-- b fully computed here, before any load
  72:   add    rax,QWORD PTR [rdi+rsi*8]                        <-- a loaded and added to b in one instruction
  76:   ret
```

`compute_call` has nothing computing `b` before the `call` at `0x16`, only register saves to keep `y`, `z`, `w` alive across it. Every instruction building `b` runs after the call returns. `compute_load` has the entire `b` expression finished by `0x6f`, before the load at `0x72` ever runs, and that load is fused directly with the final addition rather than sitting in its own instruction. Same source-level shape, same independent `b`, structurally different generated code, entirely because one crosses a call boundary and the other does not.

## Memory Ordering: When the Reordering Becomes Visible

This is where the out-of-order execution story connects directly to the memory model. The atomics and memory ordering posts covered `std::memory_order` and what acquire/release and seq_cst actually mean. The hardware reason those exist is exactly what is described here.

On x86, the hardware memory model is relatively strong: loads are not reordered with other loads, stores are not reordered with other stores, and loads are not reordered with earlier stores to the same address. But stores can be delayed relative to loads from other addresses, which means a store that has executed out of the CPU core may not yet be visible to another core reading that address.

On architectures with weaker memory models (ARM, POWER), even more reorderings are permitted by the hardware. The C++ memory model abstracts over all of these with `std::memory_order`, letting the programmer specify the minimum ordering constraint needed, and the compiler and hardware are then required to emit whatever instructions (fences, barriers, specific instruction forms) are needed to enforce it on the actual target architecture.

Without `std::memory_order` specifying a constraint, the compiler is allowed to reorder at compile time, and the hardware is allowed to reorder at runtime, and neither is required to warn you. This is why data races in C++ are undefined behavior and not just "sometimes wrong." The compiler and hardware have made changes that are only valid under the assumption that no other thread is observing.


## Quick Reference

**Coming from other languages**

Out-of-order execution and the compiler reordering it enables are hardware and compiler behaviors that exist regardless of language. Any compiled language targeting the same hardware produces code subject to the same reorderings. Managed runtimes add another layer, the JIT compiler and the runtime's own memory model, but the underlying hardware reordering still happens beneath all of it. The consequence for multithreaded code is language-independent: without explicit synchronization, no ordering guarantee exists, because neither the compiler nor the hardware is obligated to provide one.

**The 90% mental model**

The CPU runs instructions as soon as their inputs are ready, not in the order they appear in source. Instructions with no dependency between them can execute simultaneously or in swapped order. Branch prediction keeps the CPU executing speculatively past a branch before the outcome is known, and a wrong guess costs a pipeline flush. The compiler applies the same reordering at compile time. A `call` is a hard boundary neither layer can schedule across. A load is not: both the compiler and the CPU are free to run independent work around it. Both layers are constrained only by single-thread observability: a second thread can see the reorderings, which is why C++ requires explicit memory ordering for any shared-state access across threads.
