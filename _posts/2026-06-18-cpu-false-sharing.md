---
layout: post
title: "False Sharing: The Cache Line Bug That Looks Like Correct Code"
date: 2026-06-18
domain: cpu
permalink: /blog/cpu/false-sharing/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/cpu/false-sharing"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

## Intro

Your code is correct. No data race, no shared variable, no undefined behavior. Two threads writing to two independent counters. And yet throughput tanks the moment both threads run. The bug is not in the logic. It is in the memory layout. False sharing is one of those problems that does not show up in a code review and does not trigger sanitizers. It shows up in a profiler, or not at all.


## What False Sharing Is

CPUs do not fetch individual bytes from memory. They fetch 64 bytes at a time. That unit is a cache line.

When a core writes to a memory location, it takes ownership of the entire cache line containing that location. If another core holds a copy of that same cache line, that copy is immediately invalidated. The other core has to go back to memory, or a shared cache level, to get fresh data before it can do anything with it.

This is the MESI protocol at work. Modified, Exclusive, Shared, Invalid. A write on one core moves the line to Modified on that core and Invalid on every other core holding a copy. The other cores pay the cost of a cache miss on their next access, even though the data they actually care about never changed.

The problem with false sharing is that the two threads are not sharing data in any logical sense. They are writing to different variables. But if those variables sit on the same 64-byte cache line, the hardware does not know or care. Every write still invalidates the line for the other core.


## What It Looks Like in Code

```cpp
struct Unpadded {
    std::atomic<int> a;
    std::atomic<int> b; // likely same cache line as a
};
```

`a` and `b` are independent. Different threads, different variables, no synchronization needed between them at the logic level. But `sizeof(std::atomic<int>)` is 4 bytes. Both fit easily inside a single 64-byte cache line. Every write to `a` invalidates the line for the thread writing to `b`, and vice versa, even though neither thread ever touches the other's variable.

**The fix:**

```cpp
struct Padded {
    alignas(64) std::atomic<int> a; // own cache line
    alignas(64) std::atomic<int> b; // own cache line
};
```

`alignas(64)` forces each variable to the start of its own cache line. The two threads now operate on completely separate lines. No invalidation, no false sharing. The fix costs 56 bytes of padding per counter and nothing else. The logic is identical. Only the layout changes.

C++17 gives you a portable constant for this instead of hardcoding the number 64:

```cpp
#include <new>

struct Padded {
    alignas(std::hardware_destructive_interference_size) std::atomic<int> a;
    alignas(std::hardware_destructive_interference_size) std::atomic<int> b;
};
```

`std::hardware_destructive_interference_size` is typically 64 on x86, but using the standard constant makes the intent explicit and keeps the code portable to architectures with a different line size.


## Why the Compiler Does Not Save You

The compiler has no way to know that two threads will be hammering these variables at the same time. From its perspective, the struct layout is fine. The variables are correctly aligned for their type. Nothing is wrong at the language level.

This is a hardware problem. The fix has to come from the programmer, either through alignment, padding, or restructuring the data so hot variables owned by different threads do not share a line.


## Why the Two Versions were Run as Separate Processes

The benchmark runs the unpadded and padded layouts as two separate invocations of the same binary, not back to back inside one process. Running both in sequence in the same process would let cache state, thread scheduling decisions, and clock frequency ramping from the first run bleed into the second, which would muddy the comparison. Separate process invocations give each layout a clean start.


## Benchmark Output

```
$ ./benchmark unpadded
Unpadded (likely false sharing): 3304 ms
a=200000000 b=200000000

$ ./benchmark padded
Padded (own cache line each):    814 ms
a=200000000 b=200000000
```

Padding the two counters onto separate cache lines cuts wall clock time by roughly 4x on this run, from 3.3 seconds down to 0.8 seconds, for identical logic.


## perf stat

```
$ perf stat -e cache-misses,cache-references,L1-dcache-load-misses ./benchmark unpadded
Unpadded (likely false sharing): 3288 ms
a=200000000 b=200000000

 Performance counter stats for './benchmark unpadded':

        45,782,528      cache-misses
        49,254,219      cache-references
        45,635,715      L1-dcache-load-misses

       3.292390751 seconds time elapsed
       6.576136000 seconds user
       0.004000000 seconds sys


$ perf stat -e cache-misses,cache-references,L1-dcache-load-misses ./benchmark padded
Padded (own cache line each):    813 ms
a=200000000 b=200000000

 Performance counter stats for './benchmark padded':

           213,758      cache-misses
         1,161,304      cache-references
           147,277      L1-dcache-load-misses

       0.817276949 seconds time elapsed
       1.625410000 seconds user
       0.004001000 seconds sys
```

The cache miss counts tell the real story here, more than the wall clock number does. In the unpadded run, `cache-references` and `L1-dcache-load-misses` are nearly identical, 49.2 million references against 45.6 million L1 misses. That means almost every single cache access on that line missed. That is what false sharing looks like at the hardware level: two cores fighting over ownership of the same line, so neither core's copy ever stays valid long enough to be useful.

The padded version drops `L1-dcache-load-misses` from 45.6 million to 147 thousand, a reduction of roughly 300x. That swing is far larger than the 4x wall clock difference suggests on its own. The wall clock number is the visible symptom. The cache miss count is the root cause, and it moved by two orders of magnitude more than the time did. The two threads simply stopped fighting over the line once each had its own.


## Quick Reference

**Coming from other languages**

Most languages have this problem, because it is not a language problem. It is a property of how CPUs share cache hardware between cores. A handful of runtimes pad certain fields automatically under specific conditions, but the general default across languages is no protection at all. If two threads write to adjacent memory locations, false sharing can happen no matter what language produced that memory layout. The fix is always the same at the hardware level: get the variables onto separate cache lines.

**The 90% mental model**

If two threads are writing to different variables and performance is worse than expected, check whether those variables share a cache line. If the combined size of both variables is under 64 bytes and they sit next to each other in memory, they probably do. Pad each one out to its own 64-byte line and the contention disappears, with no change to the actual logic.