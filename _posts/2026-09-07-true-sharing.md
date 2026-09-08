---
layout: post
title: "True Sharing: When the Cost is Legitimate"
date: 2026-09-07
domain: cpu
permalink: /blog/cpu/true-sharing/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/cpu/true-sharing"
linkedin: "https://www.linkedin.com/posts/activity-7502757916605779968-gvNG/"
---

Not all cache line sharing costs you anything. Some of it is completely free, and the line between free and expensive comes down to one thing: whether anyone writes.

## The MESI Protocol: Why Reads Are Free and Writes Are Not

Every cache line in a CPU cache exists in one of four states defined by the MESI (Modified, Exclusive, Shared, Invalid) protocol. The state a line is in determines what happens when a core tries to read or write it.

**Shared**: the line is held by multiple cores simultaneously, all with the same clean copy. A read from a Shared line hits the local cache immediately, no coordination required, no messages sent. Every core can read the same Shared line at the same time with zero contention. This is the state that makes read-heavy workloads scale.

**Modified**: the line is owned by exactly one core and has been written to. Every other core's copy has been invalidated. If another core wants to read or write the line, the owning core must first write it back to memory (or transfer it directly, depending on the implementation), and the requesting core can then fetch the updated version.

**Exclusive**: the line is held by exactly one core but has not been written to. It is clean and consistent with memory. The core can write to it immediately without broadcasting, since no other core holds a copy.

**Invalid**: the line is not in this cache. Any access, read or write, requires fetching it from another cache or from memory.

The cost asymmetry follows directly from these states. A read that hits Shared state costs nothing beyond the local cache lookup. A write to a Shared line requires the writing core to first broadcast a Request For Ownership (RFO) to every other cache holding a copy, wait for those caches to acknowledge the invalidation, transition the line to Modified state, and only then perform the write. If another core writes to the same line before the first writer is done, the whole sequence repeats in the other direction.

## True Sharing vs False Sharing

<a href="{{ site.baseurl }}/blog/cpu/false-sharing/" target="_blank" rel="noopener noreferrer">False sharing</a> is the accidental version of this problem: unrelated variables that happen to land on the same 64-byte cache line, so writes to one cause invalidation for threads only accessing the other. The fix is mechanical, pad the variables apart to different cache lines and the problem disappears without changing program logic.

True sharing has no such fix. Multiple threads need the same piece of data, a counter, a flag, a shared state variable, and the threads are correctly coordinating around it. Padding them apart would change what the program does. The cost of true sharing is the cost of the coordination itself.

This distinction matters for how you diagnose contention. If `perf` shows cache-miss pressure on a line that multiple threads write to, and those threads are writing to logically distinct data, it is false sharing: fix the layout. If they are writing to the same logical piece of state, it is true sharing: the layout is not the problem and you need a different approach.

## The Contention Pattern

```cpp
std::atomic<long> shared_value{1};

// every thread only reads: no invalidation, cores share the cache line freely
long reader() {
    return shared_value.load();
}

// every thread writes: every write invalidates every other core's copy
void writer() {
    shared_value.fetch_add(1);
}
```

`reader` causes no coherence traffic beyond the initial fetch. Once the line is in Shared state across all reading cores, it stays there. No RFO, no invalidation, no bounce.

`writer` causes an RFO on every call. If two cores call `fetch_add` simultaneously, one wins the RFO race and performs the write, moving the line to Modified. The other core's copy is now Invalid. When the second core's RFO arrives, the first core must transfer the line. Under heavy contention with many cores all calling `fetch_add` continuously, the line bounces from core to core, never staying in one place long enough to be used efficiently.

The number of cores in the write case matters non-linearly. Two cores contending produce some bouncing. Eight cores contending produce much more than four times the bouncing, because each write invalidates all other cores simultaneously and they all then race to re-acquire ownership.

## Strategies for Reducing True Sharing

The options for mitigating true sharing depend on the access pattern.

**Per-thread local state with periodic aggregation**: instead of every thread incrementing a shared counter on every operation, each thread maintains its own local counter and a single aggregation pass sums them periodically. The shared line is written only during aggregation, not on every operation. This trades accuracy for throughput: the global total is not perfectly up to date at every moment, which is acceptable for monitoring or statistics but not for exact coordination.

```cpp
// Instead of this (every operation hits the shared line):
shared_counter.fetch_add(1);

// Each thread increments locally:
thread_local long local_counter = 0;
local_counter++;

// Aggregation (infrequent, acceptable cost):
shared_counter.fetch_add(local_counter);
local_counter = 0;
```

**Read-mostly patterns with rare writes**: if the workload is mostly reads with infrequent writes, the Shared state is where the line spends most of its time, and the occasional write just causes a brief bounce before the line settles back into Shared. The cost is proportional to write frequency, not read frequency.

`std::shared_mutex` (reader-writer lock) makes this pattern explicit. Multiple threads can hold the shared lock simultaneously and read without contention. A single writer takes exclusive ownership. For a variable that is read thousands of times between each write, the shared lock eliminates the per-read coherence traffic that a plain atomic would still incur.

**Seqlock**: a lightweight pattern for small data read far more often than written. The writer increments a sequence counter before and after each update. Readers check the counter before and after reading the data: if the counter changed mid-read, the reader retries. Writers never block on readers. Readers pay one retry cost if a write happens to land during their read.

**RCU (Read-Copy-Update)**: reads are entirely free, no atomic, no lock, no barrier. Writers create a copy of the protected data, modify the copy, and atomically swap in the pointer to the new version. Old readers finish with the old version; new readers see the new version. Memory reclamation of the old version is deferred until all readers that could have seen it are done. Used extensively in the Linux kernel for read-heavy data structures.

**Accepting the cost**: sometimes true sharing cannot be avoided and the contention is the price of coordination. A mutex protecting a shared queue, a semaphore counting available resources, a barrier synchronizing threads at a phase boundary: these all have inherent true sharing, and the cost is the cost of the synchronization itself. The only remaining question is whether the synchronization frequency can be reduced.

## Write Amplification at the Cache Line Level

One property of MESI worth knowing for true sharing: a write to a single byte of a 64-byte cache line invalidates the entire 64-byte line for every other core, not just the byte written. If two threads write to different fields in the same struct, both on the same cache line, every write by either thread invalidates the other core's copy of the entire line. This is false sharing if the fields are logically unrelated, and true sharing if they are actually coordinated.

For large structs with multiple independently-written fields, separating the hot write fields to different cache lines eliminates cross-field invalidation even when each field is legitimately shared. Combine fields that are written together on the same line; put fields written by different threads on different lines.

## Run: benchmark.cpp

```bash
g++ -O2 -std=c++26 -pthread benchmark.cpp -o benchmark
./benchmark read 1
./benchmark read 2
./benchmark read 4
./benchmark read 6
./benchmark read 8
./benchmark read 12
./benchmark read 16
./benchmark read 32
./benchmark read 64
./benchmark write 1
./benchmark write 2
./benchmark write 4
./benchmark write 6
./benchmark write 8
./benchmark write 12
./benchmark write 16
./benchmark write 32
./benchmark write 64
```

`-pthread` is required on Linux with GCC for `std::thread`. This range deliberately crosses the physical core count: 8 cores, 16 hardware threads with SMT on this CPU. The low end isolates cache-coherence cost cleanly while the high end also picks up oversubscription overhead layered on top, worth keeping separate when reading the results.

## Output

```
$ ./benchmark read 1
read with 1 threads: 4 ms
$ ./benchmark read 2
read with 2 threads: 5 ms
$ ./benchmark read 4
read with 4 threads: 6 ms
$ ./benchmark read 6
read with 6 threads: 6 ms
$ ./benchmark read 8
read with 8 threads: 5 ms
$ ./benchmark read 12
read with 12 threads: 11 ms
$ ./benchmark read 16
read with 16 threads: 12 ms
$ ./benchmark read 32
read with 32 threads: 29 ms
$ ./benchmark read 64
read with 64 threads: 47 ms

$ ./benchmark write 1
write with 1 threads: 82 ms
$ ./benchmark write 2
write with 2 threads: 326 ms
$ ./benchmark write 4
write with 4 threads: 794 ms
$ ./benchmark write 6
write with 6 threads: 1215 ms
$ ./benchmark write 8
write with 8 threads: 1470 ms
$ ./benchmark write 12
write with 12 threads: 2084 ms
$ ./benchmark write 16
write with 16 threads: 2584 ms
$ ./benchmark write 32
write with 32 threads: 5050 ms
$ ./benchmark write 64
write with 64 threads: 10106 ms
```

## What the Numbers Show

Read stays flat from 1 to 8 threads, 4 to 6 ms regardless of thread count. The Ryzen 7 5700U has 8 physical cores, so every reader up to that count gets its own hardware thread with nothing to contend over. The cache line sits in Shared state across all cores simultaneously and every load hits the local cache. The climb past 12 threads is oversubscription: more software threads than hardware threads to run them, so scheduling overhead starts appearing. That is not cache coherence traffic and should not be read as the same mechanism.

Write never stops climbing and climbs sharply from the very first additional thread: 82 ms at one writer, 326 ms at two, roughly a 4x jump from a single added thread with nothing but the RFO protocol to blame. There is no oversubscription at 2 threads. The cost is purely the cache-line bounce: each writer's `fetch_add` must acquire exclusive ownership, invalidating the other writer's copy, which then has to re-acquire ownership for its next write. Back and forth, every iteration.

The gap between read and write at matching thread counts is the direct measure of this. At 1 thread the difference is already 20x, 4 ms versus 82 ms, which reflects the base cost of a `fetch_add` being more expensive than a `load` even without contention: a read-modify-write requires exclusive ownership while a load does not. At 8 threads the gap grows past 290x, 5 ms versus 1470 ms. At 64 threads the write time scales almost exactly linearly with thread count, from 82 ms at 1 thread to 10106 ms at 64 threads, a ratio of roughly 123x for 64x more threads. The extra factor beyond linear reflects the non-linear nature of RFO traffic: each additional writer adds not just its own writes but also the cost of invalidating all other writers on every write.

## Quick Reference

**Coming from other languages**

The MESI coherence protocol operates below the language layer. Every compiled language whose code runs on x86-64, ARM, or any other cache-coherent architecture is subject to the same read-free, write-costly model. Managed languages with garbage collectors may move objects in memory, which can cause a previously Shared line to bounce if the GC writes to it during compaction, but the underlying hardware behavior is the same. The mitigation strategies (per-thread state, read-mostly patterns, RCU) are architecture-independent concepts even if the specific APIs differ between languages.

**The 90% mental model**

True sharing is the cost of threads correctly coordinating around shared state. When all threads only read a shared cache line, the MESI protocol lets every core hold its own copy simultaneously at zero ongoing cost. When any thread writes, it must broadcast an RFO to invalidate all other copies, wait for acknowledgment, and then perform the write. Under heavy write contention, the line bounces from core to core continuously. The cost scales non-linearly with the number of writing cores. Unlike false sharing, padding the layout cannot fix it. The fixes are algorithmic: reduce write frequency with per-thread local state and periodic aggregation, use reader-writer locks or RCU for read-heavy workloads, or accept the contention as the inherent cost of the coordination.
