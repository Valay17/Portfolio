---
layout: post
title: "Acquire/Release Memory Ordering: The One Way Wall Between Two Threads"
date: 2026-06-22
domain: concurrency
permalink: /blog/concurrency/memory-order/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/concurrency/memory-order"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7475089491943362560-mZaG/"
---

A write that happens earlier in your code is not guaranteed to be seen in that order by another thread. The compiler can reorder instructions. The CPU can execute them out of order. Both are allowed to do this under the as-if rule: the standard only requires that the observable behavior of a single thread matches what the code says, not that instructions execute in the order written. As long as that one thread cannot tell the difference, the reordering is legal. The moment a second thread is watching, that guarantee disappears, and memory ordering is the tool that puts it back.

## The Wall Model

Acquire and release are best understood as a one way wall, and that wall only exists between two threads if they are both touching the same atomic variable.

A `release` store says: everything written before this point in program order is now visible to any thread that performs a matching acquire load on this atomic. Writes can move forward past the wall. Nothing from after the wall can move backward across it.

An `acquire` load says the mirror version: anything read after this point can see everything that happened before the matching release. Reads can move backward past the wall from the other side. Nothing from before the wall can leak forward across it.

This is a private agreement between exactly two threads, the ones using that one atomic variable. No other thread in the program gets any guarantee from this pair. If a third thread reads the same data through a different atomic, or with no synchronization at all, it has no relationship to this wall whatsoever.

```cpp
// release (write side)
data = 69;
ready.store(true, std::memory_order_release);
// nothing written before this line can be moved below it

// acquire (read side)
while (!ready.load(std::memory_order_acquire));
print(data); // guaranteed to see 69
// nothing read after this line can be moved above it
```

The wall is per-variable, not per-program. That distinction matters more than it looks, because it is exactly what falls apart once a second atomic enters the picture.

## seq_cst is the Same Wall, Extended Globally

`memory_order_seq_cst` provides the same acquire and release guarantees, but adds one more constraint: every thread in the program agrees on a single global order for every seq_cst operation, including atomics that thread never touches directly. That global agreement, not the ordering itself, is the actual cost. Two threads using acquire/release on one atomic only need to agree with each other. A program using seq_cst needs every thread to agree on one timeline for all of it.

On x86, this is less expensive than it sounds, because x86 already provides fairly strong ordering at the hardware level by default. seq_cst is the default for atomics in C++ precisely because it is the safest choice to reach for first. The cost shows up more clearly when a full fence is actually required, which can slow down multicore execution measurably. acquire and release are half barriers: one side only. seq_cst is a full barrier: both sides, globally.

There is also a middle level between plain acquire/release and seq_cst, worth naming even though this post does not lean on it directly: `acq_rel`. It applies to read-modify-write operations, things like `fetch_add` or `compare_exchange`, which read the current value and write a new one in a single atomic step. Since the operation does both at once, it can act as acquire on the read half and release on the write half simultaneously. The reach is still the same as plain acquire/release though, scoped to threads synchronizing through that same atomic. A thread elsewhere in the program that never touches that variable gets nothing from an acq_rel pair either.

## relaxed Has No Wall

```cpp
ready.store(true, std::memory_order_relaxed);
// atomic only. no ordering guarantee at all.
```

`memory_order_relaxed` guarantees the operation itself is atomic. The variable cannot be torn or corrupted by concurrent access. It guarantees nothing about ordering relative to anything else. The compiler and the CPU are both free to reorder a relaxed operation relative to surrounding code.

The real use case for relaxed is something like a view counter, a request counter, or a stats tally, where the only requirement is that increments do not corrupt each other. A video view count climbing on a busy server is a good example: a thousand increments landing in a slightly different order than they technically occurred in does not change the final number, and nobody downstream cares which one happened first. The only thing that matters is that the count itself never gets torn or lost.

In practice relaxed is reached for far less often than acquire/release or seq_cst. Most shared state has some dependency riding alongside it, a flag that gates access to other data, a pointer being published, a result another thread needs to read correctly. The moment there is anything else attached to the atomic that the other thread depends on, relaxed is the wrong choice. It earns its place only when the value is genuinely self contained.

## What Synchronizes with What

The formal model behind this has a specific name for the moment a release and a matching acquire connect: **synchronizes-with**. If thread A stores to an atomic with release and thread B loads that same atomic with acquire and observes the value A stored, A is said to synchronize-with B. That relationship is what extends into **happens-before**: if A is sequenced before some operation, or synchronizes-with some operation, that ordering holds across threads, transitively, even through intermediate steps. This is the actual rule the wall model is a mental shortcut for. The wall is real because the standard defines synchronizes-with and happens-before in exactly those terms.

One detail worth knowing: `std::memory_order_consume` was meant to be an even cheaper variant of acquire for a narrower set of cases, but it turned out to be too difficult to specify and implement correctly. It has been deprecated. Acquire is the right tool for this pattern, not consume.

## The Demo

The simplest producer/consumer example, one writer signaling a single ready flag, is easy to get right with acquire/release and does not actually expose the gap between acquire/release and seq_cst. To see that gap, you need at least two atomics and two readers checking them in different orders.

The demo here uses three threads. One writer stores into two separate atomics, `x` and `y`. Two reader threads each read both atomics, in opposite orders: reader1 reads `x` then `y`, reader2 reads `y` then `x`.

```cpp
struct State {
    std::atomic<int> x{0};
    std::atomic<int> y{0};
};
```

`acquire-release.cpp` uses release on both stores and acquire on both loads:

```cpp
std::thread writer([&]() {
    state.x.store(1, std::memory_order_release);
    state.y.store(1, std::memory_order_release);
});

std::thread reader1([&]() {
    r1.first_value = state.x.load(std::memory_order_acquire);
    r1.second_value = state.y.load(std::memory_order_acquire);
});

std::thread reader2([&]() {
    r2.first_value = state.y.load(std::memory_order_acquire);
    r2.second_value = state.x.load(std::memory_order_acquire);
});
```

The wall release/acquire creates only exists between the writer and each individual atomic. The writer's release store to `x` is paired with a reader's acquire load of `x`. The writer's release store to `y` is paired separately with a reader's acquire load of `y`. Nothing in this pairing says anything about whether `x` and `y` became visible in the same relative order to both readers, because `x` and `y` are two separate walls, not one shared timeline. Reader1 and reader2 are allowed to disagree about which one arrived first. Neither reading is a data race and neither is undefined behavior. Every access here is correctly paired. The gap is narrower and easier to miss than a race: acquire/release alone simply does not promise the two readers will agree with each other.

The code checks for exactly that disagreement, run repeatedly up to two million times, stopping the moment it finds one:

```cpp
bool reader1_saw_x_only = (r1.first_value == 1 && r1.second_value == 0);
bool reader2_saw_y_only = (r2.first_value == 1 && r2.second_value == 0);

if (reader1_saw_x_only && reader2_saw_y_only) {
    found_disagreement = true;
    // reader1 implies x became visible before y.
    // reader2 implies y became visible before x.
    // acquire/release does not forbid this.
}
```

`seq-cst.cpp` is the identical three thread layout, with every operation on `x` and `y` changed to `memory_order_seq_cst`:

```cpp
std::thread writer([&]() {
    state.x.store(1, std::memory_order_seq_cst);
    state.y.store(1, std::memory_order_seq_cst);
});

std::thread reader1([&]() {
    int saw_x = state.x.load(std::memory_order_seq_cst);
    int saw_y = state.y.load(std::memory_order_seq_cst);
});

std::thread reader2([&]() {
    int saw_y = state.y.load(std::memory_order_seq_cst);
    int saw_x = state.x.load(std::memory_order_seq_cst);
});
```

seq_cst places every seq_cst operation in the program into one single global order all threads agree on, including operations on `x` and operations on `y`, even though they are different atomics. Reader1 and reader2 cannot end up implying two different orders for when `x` and `y` became visible, because both readers are constrained by the same one timeline instead of two independent per-variable walls. This file runs once. There is nothing to search for, because the disagreement the other file hunts for is not possible here.

## What You Might See on This Machine

x86 already provides fairly strong ordering at the hardware level for ordinary loads and stores. Run `acquire-release.cpp` on this kind of CPU and it will most likely report no disagreement found, even after two million attempts, even though acquire/release alone does not technically forbid that disagreement from happening.

That is not the demo failing. It is the same well known reason subtly wrong memory ordering can run correctly for years on x86 and then break the moment the same code runs on a weakly ordered architecture like ARM. The guarantee acquire/release does not give you is still absent. This machine's hardware just happens to provide a stronger guarantee underneath it anyway, and that extra guarantee is not something the code is allowed to rely on, because the standard does not promise it.

Read both files as a statement about what the C++ standard does and does not promise, not as a prediction of what will visibly break on this specific run. The difference between `acquire-release.cpp` and `seq-cst.cpp` lives in the language's guarantees, not necessarily in what gets observed on one machine on one day.

## Output

```
acquire-release:

No disagreement found in 2000000 runs. See the README for why this is the expected result on x86, not evidence that the ordering guarantee exists.

seq_cst:

reader1: saw x = 1
reader1: saw y = 1
reader2: saw y = 1
reader2: saw x = 1

With seq_cst, reader1 and reader2 are placed on the same global timeline as the writer's stores to x and y. They cannot disagree about the relative order x and y became visible, the way acquire/release alone permitted.
```

## Why the Release/Acquire Pair is the Mechanism Behind Lock-Free Structures

A producer doing a release store after writing data, paired with a consumer doing an acquire load before reading it, is the entire mechanism behind lock-free queues, spinlocks, and most concurrent data structures that do not go through a mutex. No kernel involvement, no blocking syscall, just a correctly placed wall between exactly the two threads that need to agree on visibility. The two-atomic demo above is the reason a real lock-free structure with more than one piece of shared state needs to think carefully about whether per-variable walls are actually sufficient, or whether a stronger ordering is needed to keep multiple readers in agreement.

## Quick Reference

**Coming from other languages**

Most languages with a memory model expose something close to this same set of orderings, because the underlying hardware behavior is the same across architectures. The names and exact defaults differ, but the concept is identical everywhere: a release-style operation publishes everything before it, a matching acquire-style operation receives that publication, and the two only agree with each other, not with the rest of the program. Some languages default to the strongest ordering everywhere, accepting the global agreement cost so the average programmer never has to think about it. Whatever language you came from, if it has atomics at all, it has this same wall hiding under different names.

**The 90% mental model**

`acquire` and `release` only mean something as a pair, on the same atomic variable, between the two threads using it. Picture a `release` store as sealing everything written before it into a package, and the matching `acquire` load as the only key that unpacks it. If you are not pairing a `release` with an `acquire` on the same variable, you have no wall and no guarantee, regardless of what the output looks like on your machine today. `seq_cst` is the same package and key, except every thread in the program agrees to use the same numbered sequence for handing packages around, even threads that never touch that particular package.
