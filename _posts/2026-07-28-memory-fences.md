---
layout: post
title: "Memory Fences: What the Compiler and Hardware Each Actually Do"
date: 2026-07-28
domain: concurrency
permalink: /blog/concurrency/memory-fences/
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7487719750890831872-gc53"
---

Most of what a memory fence does has nothing to do with the CPU. It is the compiler you are fencing. Understanding the split between the two, when a fence generates an actual instruction and when it only constrains code generation, requires looking at what a fence actually is in the C++ memory model and what x86 hardware already provides for free.

## What a Fence Actually is

In the C++ memory model, `atomic_thread_fence` and `atomic_signal_fence` are not operations on atomic variables. They are standalone synchronization constraints that affect the ordering of memory operations relative to the fence. A fence with release semantics prevents any prior write from being reordered past the fence. A fence with acquire semantics prevents any subsequent read from being reordered before the fence. Neither constraint says anything about CPU instructions until you ask what is needed to enforce it on a specific architecture.

The key distinction from the acquire/release post: a release store on an atomic variable builds the ordering constraint into the store itself. A release fence separates the constraint from the operation: you place the fence, then perform a separate store that can be relaxed. This gives more flexibility at the cost of being harder to reason about correctly.

```cpp
// Version 1: ordering built into the operation (release store)
data = 69;
flag.store(1, std::memory_order_release);

// Version 2: ordering via fence + relaxed operation
data = 69;
std::atomic_thread_fence(std::memory_order_release);
flag.store(1, std::memory_order_relaxed);  // store itself carries no ordering
```

Both versions prevent `data = 69` from being reordered past the flag write. The fence version requires both sides to use fences for the synchronization to hold, which the next section covers.

## atomic_thread_fence on x86: Hardware Shows Up Only for seq_cst

On x86 and x86-64, `atomic_thread_fence` with `acquire`, `release`, or `acq_rel` ordering emits no CPU instructions. Confirmed directly from cppreference: on x86, these fences only affect compile-time code motion.

The reason is that x86 already has strong ordering guarantees built into its memory model. Regular loads on x86 are not reordered with other loads. Regular stores are not reordered with other stores. A load is not reordered before a prior store to the same address. The hardware enforces the ordering that acquire and release fences exist to provide, so the fence only needs to tell the compiler not to reorder across it. No instruction is needed to tell the CPU anything it would not have done on its own.

`seq_cst` is the exception. Sequential consistency requires a single global order that every thread agrees on for every sequentially consistent operation in the program, regardless of which variable is being accessed. x86's store-buffer model does not provide this for free: a store can sit in the store buffer before becoming visible to other cores, and until it drains, a different thread's sequentially consistent load on an unrelated variable could complete before this store is visible globally. To enforce the global ordering `seq_cst` requires, x86 needs a hardware memory barrier. The instruction GCC typically emits is not `mfence` but `lock or QWORD PTR [rsp], 0`, a locked OR on the stack pointer. The locked prefix on any x86 instruction makes it a full memory barrier, and this particular form is commonly preferred over `mfence` because it tends to run faster on modern microarchitectures while providing the same guarantee. The stack pointer is used as the target because it is always a valid mapped address and the operation itself has no effect on the value stored there, making it a no-op with a barrier side-effect.

```asm
; atomic_thread_fence(acquire) on x86
ret                             ; nothing — compiler barrier only

; atomic_thread_fence(seq_cst) on x86
lock or QWORD PTR [rsp], 0     ; the actual instruction GCC emits
ret

; atomic_signal_fence(seq_cst) on x86
ret                             ; still nothing, even at the strictest ordering
```

Three function bodies, one line of difference between two of them. `acquire` and `release` fences cost nothing at the hardware level on x86. `seq_cst` thread fences cost one instruction. Signal fences cost nothing regardless of ordering.

On architectures with weaker memory models, ARM and POWER for example, the picture changes entirely. Acquire and release fences do emit hardware instructions there because the hardware does not provide x86's default ordering guarantees.

## atomic_signal_fence: Never a Hardware Instruction

`atomic_signal_fence` takes the same ordering arguments as `atomic_thread_fence` but never emits a hardware instruction under any ordering, including `seq_cst`. This is not an optimization: it is the correct behavior given what a signal fence is for.

A signal handler is not a separate thread. It runs on the same physical core, interrupting the thread at some arbitrary point and executing on the same hardware context. There is no cross-core visibility problem to solve. The hardware is not going to reorder a signal handler's accesses relative to the thread's accesses in a way that breaks the sequencing, because they are both the same hardware thread. The only danger is the compiler reordering your code in a way the signal handler could observe mid-sequence, which is purely a compile-time concern.

```cpp
int data = 0;
std::atomic<int> flag{0};

void signal_handler(int) {
    // no instruction emitted here, purely compile-time constraint
    std::atomic_signal_fence(std::memory_order_acquire);
    if (flag.load(std::memory_order_relaxed) == 1) {
        int x = data;   // guaranteed to see data == 69
    }
}

int main() {
    data = 69;
    // no instruction emitted here either
    std::atomic_signal_fence(std::memory_order_release);
    flag.store(1, std::memory_order_relaxed);
    // raise signal or continue
}
```

The acquire fence in the signal handler prevents the compiler from floating the `data` read before the flag read. The release fence in main prevents the compiler from sinking `data = 69` below the flag store. No instruction is needed because the CPU maintains the sequencing within a single thread automatically. The fence only constrains the compiler.

## The Four Modification Order Coherence Guarantees

Every atomic variable in C++ has a modification order: a single total order of all writes to that variable that every thread agrees on. This is separate from the global sequentially consistent order. Even with relaxed atomics, there is still one modification order per variable, and the four coherence guarantees define what that means for loads and stores.

**Write-write coherence**: if write A to X happens-before write B to X (via some happens-before chain), then A appears before B in the modification order of X. No thread will ever observe B without having first been able to observe A.

**Read-read coherence**: if read A of X happens-before read B of X, and A observes the value written by some write W, then B observes either W or a write that appears later than W in the modification order of X. Reading a value and then reading an older value is not possible within a happens-before chain.

**Read-write coherence**: if read A of X happens-before write B to X, then A does not observe the value written by B or any later write. A read cannot observe a write that logically comes after it.

**Write-read coherence**: if write A to X happens-before read B of X, then B observes A or a write that appears later than A in the modification order of X. A read that comes after a write must see at least that write.

Together these four guarantees mean that even with relaxed atomics, every thread sees a coherent history of writes to each atomic variable. There are no time-travel anomalies within the modification order of a single variable, even when the happens-before chain is established by something other than the variable itself.

## Release Sequences: Synchronizing Through a Chain

A **release sequence** headed by a release store R on variable M is the longest sequence of subsequent modifications to M where each operation is either:

- A read-modify-write operation on M by any thread (CAS, `fetch_add`, `fetch_or`, etc.)
- Any store to M by the same thread that performed R

The significance: an acquire load that reads a value written by any operation in R's release sequence synchronizes with R. Without this rule, a producer-consumer pattern involving an intermediate thread doing an RMW would break.

```cpp
// Thread 1 (producer):
data = 69;
flag.store(1, std::memory_order_release);    // head of the release sequence

// Thread 2 (counter, RMW extends the release sequence):
flag.fetch_add(1, std::memory_order_relaxed); // in the release sequence of Thread 1's store

// Thread 3 (consumer):
int val = flag.load(std::memory_order_acquire);
// if val >= 1, this load synchronizes with Thread 1's release store
// Thread 3 is guaranteed to see data == 69
```

Without release sequences, Thread 3's acquire load reading a value written by Thread 2's `fetch_add` would not synchronize with Thread 1's release store, because Thread 2 did not perform a release. Thread 3 could see `flag >= 2` but have no guarantee about `data`. Release sequences close this gap: the chain of RMW operations extends the release fence of the original store, allowing any consumer that reads a value from that chain to synchronize with the original producer.

A plain store by a different thread breaks the release sequence. Only RMW operations by any thread, or stores by the original releasing thread, extend it.

## Fence-Fence Synchronization

The simplest acquire/release pattern is a release store on one side and an acquire load on the other. Fences make a different pattern possible: a relaxed operation on both sides, with fences handling the ordering.

For fence-fence synchronization to establish a synchronizes-with relationship, the C++ standard requires all of the following:

- Thread 1 performs a release fence F1, then any atomic write X to variable M (with any ordering)
- Thread 2 performs any atomic read Y of M (with any ordering) that reads the value written by X (or a value in X's release sequence), then performs an acquire fence F2

Under these conditions, F1 synchronizes with F2, and everything sequenced before F1 in Thread 1 happens-before everything sequenced after F2 in Thread 2.

```cpp
std::atomic<int> flag{0};
int data = 0;

// Thread 1:
data = 69;
std::atomic_thread_fence(std::memory_order_release);  // F1
flag.store(1, std::memory_order_relaxed);              // X: write to flag

// Thread 2:
while (flag.load(std::memory_order_relaxed) == 0);    // Y: reads value written by X
std::atomic_thread_fence(std::memory_order_acquire);  // F2
assert(data == 69);                                    // guaranteed: F1 syncs with F2
```

The subtlety here compared to a release store plus acquire load: the store and load themselves are relaxed. They carry no ordering guarantee individually. All the ordering comes from the fences. The condition that Y reads the value written by X (rather than some stale value) is what creates the chain connecting F1 to F2. If Y reads a stale value that Thread 1 did not write after F1, the synchronization does not hold.

This pattern is occasionally useful when you need to perform multiple relaxed operations on an atomic between the fence and the synchronizing read, but it requires careful reasoning to apply correctly. The release store plus acquire load form is simpler and less error-prone for most use cases.

## Quick Reference

**Coming from other languages**

Fence semantics map to whatever the target architecture requires, regardless of language. A language that exposes fence operations maps them to compiler barriers and hardware barriers in exactly the way described here: weak architectures need hardware instructions for acquire and release, strong architectures like x86 only need them for sequential consistency. The signal fence distinction is also architecture-independent: synchronizing with a signal handler on the same thread is always a compile-time-only concern because the hardware thread model does not allow the CPU to reorder within a single thread's execution stream.

**The 90% mental model**

`atomic_thread_fence` is a compiler barrier that may also be a hardware barrier depending on the ordering and architecture. On x86, acquire and release orderings cost nothing at the CPU level because x86 already provides that ordering. Only seq_cst requires an instruction because it asks for something x86 does not give for free: a globally agreed-upon single order across all seq_cst operations. `atomic_signal_fence` is always and only a compiler barrier, even at seq_cst, because it is not synchronizing two threads but a thread with its own signal handler, which runs on the same core with no cross-core visibility problem to solve. Modification order coherence guarantees that every thread sees a coherent history of writes to each atomic variable, no time-travel anomalies, even with relaxed atomics. Release sequences extend synchronization through chains of read-modify-write operations, so a consumer can synchronize with a producer even when an intermediate thread modified the same variable in between.
