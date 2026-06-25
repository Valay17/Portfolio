---
layout: post
title: "Memory Fences: A Wall With No Atomic Attached"
date: 2026-06-23
domain: concurrency
permalink: /blog/concurrency/memory-fences/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/concurrency/memory-fences"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7475427381902635008-qkbL/"
---

A memory fence is not a hardware switch. It is an instruction to the compiler about what it is allowed to reorder. On x86, the hardware is already strongly ordered for most operations, so a fence's job is mostly done at compile time, by stopping the compiler from moving things around. seq_cst is the exception. It needs an actual CPU instruction to enforce a global order across cores, because that guarantee is stronger than anything the hardware gives you by default.

The previous post in this series covered the full set of memory orderings, relaxed, the now-deprecated consume, acquire, release, acq_rel, and seq_cst, as a single spectrum from no guarantee at all to full global agreement. Everything on that spectrum, up through acq_rel, is attached to a specific atomic operation. The wall exists where the atomic access happens, scoped to that one variable. A fence is what happens when that wall gets pulled off the variable entirely.

## What a Fence actually is

`std::atomic_thread_fence` takes one of those same ordering values, most often `seq_cst`, and applies it at a specific point in the code rather than at a specific atomic access. Everything around that point gets ordered, atomics and ordinary non-atomic memory access both, not just the one variable a normal atomic operation would have been scoped to.

There is one hard requirement that makes a standalone fence easy to misuse: a fence needs an atomic operation somewhere nearby to have any effect at all. The fence is a rule about reordering relative to something. If there is no atomic operation anywhere in the picture, there is nothing for that rule to anchor to, and the fence accomplishes nothing.

```cpp
flag_a = true;
// nothing stops the compiler from moving the read of flag_b above this line, with no fence and no atomic involved
if (!flag_b) { /* wrongly believes it has exclusive access */ }
```

Adding a fence with no atomic nearby would change nothing here. The fix needs both a fence and an atomic operation placed together:

```cpp
flag_a = true;
dummy_atomic.fetch_add(0, std::memory_order_relaxed); // gives the fence something to attach to
std::atomic_thread_fence(std::memory_order_seq_cst);   // the actual wall
if (!flag_b) { /* now correctly ordered after the write to flag_a */ }
```

`dummy_atomic` here does not carry any meaningful data. Its only job is to give the fence an atomic operation to attach itself to. Fences can also be combined with real atomics that are already doing useful work elsewhere in the code, and fence-with-fence combinations exist as well, but the underlying requirement never changes: no atomic operation involved anywhere, no effect from the fence.

## atomic_signal_fence Solves a Different Problem

`atomic_signal_fence` looks like a sibling of `atomic_thread_fence`, but the problem it solves is not about two threads at all. It orders memory access between a thread and a signal handler running on that same thread. A signal handler is effectively a hardware or OS interrupt firing into the middle of a thread's own execution, not a second thread running concurrently.

The shape of the problem is the same: the compiler can reorder instructions around the point where the handler might fire, the same way it can reorder instructions around two threads communicating. The fix is the same family of tool. But the two sides of the wall here are one thread and its own interrupt handler, not two separate threads. Like `atomic_thread_fence`, this generates no CPU instructions at all. It is purely a compiler-level reordering barrier, since there is no second core involved that would need a hardware-level guarantee.

## volatile is Not Part of this System

`volatile` is worth ruling out explicitly here, since people coming from other backgrounds sometimes expect it to do some of what a fence or an atomic does. In C++, `volatile` tells the compiler not to optimize away or cache a read or write to a particular memory location, which matters for things like memory-mapped hardware registers where a value can change outside the program's own control flow.

That is the entire guarantee `volatile` provides. It is not atomic, so a `volatile` variable incremented from two threads can still tear. It carries no memory ordering of any kind and no synchronization with any other thread. None of the wall behavior that acquire, release, acq_rel, or seq_cst provide exists here, and a fence placed near a `volatile` access gets nothing to anchor to, since `volatile` is not an atomic operation. If the goal is synchronizing threads, `volatile` is simply not part of that toolkit. `std::atomic` is the correct reach, every time.

## What the Code Demonstrates

Two files here, each showing a different side of fences.

### dekker.cpp: Making the Reordering Observable

`dekker.cpp` forces a fence's effect to become visible through an actual mutual exclusion violation, in the style of Dekker's algorithm. Two threads each set their own plain bool flag, then check the other thread's flag before entering a critical section.

```cpp
bool flag_a = false;
bool flag_b = false;
std::atomic<int> dummy_atomic{0};
long long shared_counter = 0;
```

Without any fence, the compiler and CPU are free to reorder the write to a thread's own flag after its read of the other thread's flag. That reordering lets both threads conclude the other has not started yet, and both enter the critical section at the same time.

```cpp
std::thread t1([&]() {
    flag_a = true;
    if (!flag_b) {
        a_entered = true;
        ++shared_counter;
    }
});
std::thread t2([&]() {
    flag_b = true;
    if (!flag_a) {
        b_entered = true;
        ++shared_counter;
    }
});
```

With a fence placed between the flag write and the flag read, paired with the dummy atomic operation described above, that reordering is prevented:

```cpp
flag_a = true;
dummy_atomic.fetch_add(0, std::memory_order_relaxed);
std::atomic_thread_fence(std::memory_order_seq_cst);
if (!flag_b) {
    a_entered = true;
    ++shared_counter;
}
```

This is Dekker-flavored, not Dekker's actual algorithm. The real algorithm uses a wait loop instead of a single check. It is simplified here on purpose, to make violations easier to trigger and count within a reasonable number of iterations.

Each mode runs as its own process invocation, not back to back in the same run, for the same reason every other comparison in this series isolates runs: thread scheduling behavior from one mode should not bleed into the next.

Each run reports two things: how many times both threads entered the critical section together, and what the unprotected shared counter ended up at. If mutual exclusion held the entire time, the counter should equal the iteration count exactly. Any other value, or any nonzero count of both threads entering together, is direct evidence the reordering happened.

This is genuinely a data race in the no-fence case, since the shared counter increment is unprotected. ThreadSanitizer correctly flags this one. That is worth noting against the previous post in this series, where the relaxed-ordering demo was technically undefined behavior under the standard but had no actual unprotected write for ThreadSanitizer to point at directly. Here, the unprotected `shared_counter` increment is a textbook data race sitting right on top of the ordering violation, and a tool built to catch races will catch it without needing the ordering subtlety explained first.

### fence-codegen.cpp: Seeing the Cost Directly

`fence-codegen.cpp` is not meant to be run. It exists to be compiled to assembly and inspected with `objdump`, to see directly what a fence costs on real hardware.

```cpp
std::atomic<int> counter{0};

void no_fence() {
    counter.store(1, std::memory_order_relaxed);
}

void with_seq_cst_fence() {
    counter.store(1, std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_seq_cst);
}
```

`no_fence` does a relaxed atomic store with nothing else around it. On x86, that should compile to a single plain store instruction, with no fence instruction involved, since a relaxed store needs no ordering guarantee beyond atomicity itself. `with_seq_cst_fence` does the same store, then adds a standalone seq_cst fence right after. That version should show extra instructions, typically something equivalent to a locked instruction or an explicit fence instruction, because seq_cst is the one ordering on the entire spectrum that actually requires the CPU to do something at runtime, rather than just telling the compiler to leave the code alone.

## Run: dekker.cpp

Compile once:

```bash
g++ -O2 -std=c++20 -pthread dekker.cpp -o dekker
```

`-O2` keeps the build representative of real code, since an unoptimized build can mask or change reordering behavior on its own. `-pthread` is required on Linux with GCC whenever `std::thread` is used.

Run each mode as its own process, separately:

```bash
./dekker no-fence
./dekker with-fence
```

Running these separately, rather than back to back in one process, keeps thread scheduling behavior from one run from influencing the other.

## Run: fence-codegen.cpp

Compile to assembly, no execution:

```bash
g++ -O2 -std=c++20 -c fence-codegen.cpp -o fence-codegen.o
objdump -d --no-show-raw-insn fence-codegen.o
```

`-c` compiles to an object file without linking or producing a runnable binary, since this file has no `main` and is not meant to run. `objdump -d` disassembles the compiled object file into assembly. `--no-show-raw-insn` hides the raw instruction bytes, leaving just the mnemonics, which is easier to read for a side-by-side comparison.

Look for the disassembly of `no_fence()` and `with_seq_cst_fence()` separately in the output.

## Output

```
dekker.cpp no-fence:
no-fence: both threads entered together 28 times out of 2000000 iterations
no-fence: shared_counter ended at 2000000 (expected 2000000 if mutual exclusion held)

dekker.cpp with-fence:
with-fence: both threads entered together 0 times out of 2000000 iterations
with-fence: shared_counter ended at 1999989 (expected 2000000 if mutual exclusion held)

```

```
objdump disassembly no_fence:
0000000000000000 <_Z8no_fencev>:
   0:   mov    0x0(%rip),%rax        # 7 <_Z8no_fencev+0x7>
   7:   movl   $0x1,(%rax)
   d:   xor    %eax,%eax
   f:   ret

objdump disassembly with_seq_cst_fence:
0000000000000010 <_Z18with_seq_cst_fencev>:
  10:   mov    0x0(%rip),%rax        # 17 <_Z18with_seq_cst_fencev+0x7>
  17:   movl   $0x1,(%rax)
  1d:   lock orq $0x0,(%rsp)         <-- Notice this instruction here
  23:   xor    %eax,%eax
  25:   ret

```
Info on the lock x86 instruction: it is not an instruction itself, it is an instruction prefix, which applies to the following instruction. It is applied to something that does a read-modify-write(RMW) on memory. 

The LOCK prefix ensures that the CPU has exclusive ownership of the appropriate cache line for the duration of the operation, and provides certain additional ordering guarantees. This may be achieved by asserting a bus lock, but the CPU will avoid this where possible. If the bus is locked then it is only for the duration of the locked instruction.

## Quick Reference

**Coming from other languages**

Most languages that expose a memory model also expose some form of standalone fence, separate from any specific atomic variable, for exactly this reason: sometimes the thing that needs ordering is a broader region of code, including ordinary non-atomic memory, not just one atomic access. The requirement that a fence needs something atomic nearby to mean anything carries over regardless of language, since it follows from what a fence fundamentally is, not from any one language's design choice.

**The 90% mental model**

Reach for a fence only when you need to order a block of code, not just one atomic access, and pairing acquire and release on a single variable does not cover the shape of what you are protecting. Pairing release and acquire on the same atomic is enough for almost everything you will write. A standalone fence is the exception, and it only works at all if there is an atomic operation somewhere nearby for it to attach to.
