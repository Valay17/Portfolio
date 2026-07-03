---
layout: post
title: "Lock-Free vs Wait-Free: The Actual Difference"
date: 2026-07-01
domain: concurrency
permalink: /blog/concurrency/lock-free-wait-free/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/concurrency/lock-free-wait-free"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7478304161168551937-nMxZ/"
---

Lock-free does not mean every thread makes progress. It means the system as a whole always does.

## The Distinction

Lock-free guarantees that at least one thread completes its operation in a bounded number of steps, even if some other thread gets stuck in a retry loop forever. Wait-free is the stronger guarantee: every single thread completes in a bounded number of steps, no thread can be starved no matter what the others are doing.

Wait-free is always lock-free. Lock-free is not always wait-free. The lock in lock-free refers to software primitives, mutexes, spinlocks, system-wide synchronization, not hardware-level cache coherence. The LOCK prefix visible in the assembly below is a cache-line level operation, a fundamentally different mechanism from `std::mutex` or any kernel-level lock primitive.

A CAS retry loop is the clearest example of the gap between the two. Multiple threads racing to update the same atomic with `compare_exchange` will always have one thread win and make progress on any given contention point. That satisfies lock-free. But the threads that lost the race retry, and under enough contention, a specific unlucky thread could keep losing indefinitely. The system never stalls, but that one thread's progress is not guaranteed. Lock-free without wait-free.

`fetch_add` on x86 is a different story. It maps to a single `lock add` instruction. Every thread that calls it completes in exactly one step regardless of contention. No retry, no loop. That is wait-free, and the assembly makes it visible.

Wait-free algorithms are harder to write and rarer in practice, since you need a bound on every thread's steps regardless of what every other thread is doing simultaneously. When you do see a wait-free structure in production, it is usually a sign of serious engineering effort behind it.

## Obstruction-Free: The Guarantee Below Lock-Free

Lock-free and wait-free are not the only two points on this scale. There is a third, weaker guarantee below both: obstruction-free. An obstruction-free algorithm guarantees a thread completes its operation in a bounded number of steps only if it eventually runs without interference, no other thread executing conflicting instructions at the same time. Under actual contention, an obstruction-free algorithm can livelock: two threads repeatedly aborting and retrying because of each other, with the system as a whole making no progress at all, unlike lock-free, where at least one thread always wins each round.

The three guarantees form a strict hierarchy. Wait-free implies lock-free. Lock-free implies obstruction-free. Every wait-free algorithm is automatically both of the weaker guarantees. Most lock-free algorithms used in practice happen to be obstruction-free too, but the reverse does not hold, an obstruction-free algorithm has no obligation to make system-wide progress under contention, only individual progress in isolation.

**Obstruction-free vs mutex: the failure modes are inverted.** A mutex is vulnerable to suspension of the lock-holder. If a thread acquires the mutex and gets preempted, every other thread blocks at the entrance until the OS reschedules that one thread. One suspended thread stops the entire system. Obstruction-free has the opposite vulnerability. If one thread is suspended mid-operation, every other thread can still run alone and complete successfully, since the guarantee only requires progress when a thread runs without interference. But if two threads are both active and keep interfering with each other's reads and writes, neither may make progress at all.

A concrete scenario makes this visible:

```
Thread A reads shared state (sees value V).
Thread A gets preempted before writing.

Threads B, C, D each run, see no active contender,
complete their operations, and move on.
Thread A's partial state sits in memory but blocks no one.
-- obstruction-free holds; mutex would have blocked B, C, D --

Now thread A resumes and thread E starts simultaneously.
Thread A reads V, thread E reads the current value V'.
Thread A writes V+1, invalidating E's snapshot.
Thread E detects the conflict, aborts, restarts.
Thread E reads again; thread A has meanwhile started another read.
Thread A detects E's write, aborts, restarts.
Neither makes progress.
-- livelock. mutex would not have this problem --
```

The practical upshot is that obstruction-free algorithms need a contention manager sitting on top: randomized backoff, priority schemes, something that breaks the symmetry when two threads keep colliding. Software transactional memory is the most common place this guarantee shows up in the literature, since STM's optimistic commit-or-abort model fits obstruction-freedom naturally, and it needs exactly that backoff layer for production use.

## What "Bounded" Actually Means

The word bounded in both definitions is precise and worth unpacking, because it covers two meaningfully different cases that are both technically wait-free.

The counter in this post is wait-free by the simplest possible bound: every thread completes in exactly one step, always, regardless of how many other threads exist or what they are doing. That bound is a constant. It does not depend on the number of threads, it does not depend on contention, it does not change as the system scales. One instruction, done.

Wait-free algorithms for complex operations, queues, stacks, trees, cannot usually achieve a constant bound. The standard technique for building them involves **helping**, covered in the next section, and helping introduces a bound that scales with the number of threads. A thread might need to complete up to O(n) pending operations from other threads before it can complete its own. That is still wait-free by definition, because the bound exists and every thread is guaranteed to complete in a finite number of steps, but the constant-vs-linear distinction matters in practice. A wait-free queue with a per-operation cost of O(n) steps on a 64-thread system is doing meaningfully more work per operation than a lock-free queue that usually completes in O(1) steps under low contention, even though both satisfy their respective guarantees.

This is why claiming "wait-free" is not the end of the analysis. The bound itself matters, and so does whether that bound is tight in the common case.

## How Wait-Free Algorithms Are Built

The counter example in this post is a trivial case of wait-free: x86 provides a single hardware instruction that does the whole thing atomically, so there is nothing more to synchronize. `fetch_add` maps directly to `lock add`. One instruction. Done.

For a more complex operation like pushing to a queue or updating a tree node, there is no single instruction that does the whole thing. Multiple steps are required, and with multiple steps comes the possibility that another thread's progress blocks yours. To achieve a wait-free guarantee on a complex operation, the standard technique is **helping**.

> Before a thread attempts its own operation, it checks a shared announcement table where threads publish what they intend to do. If another thread has announced an operation that has not been completed yet, the current thread completes that pending operation on its behalf before proceeding. Every active thread acts as a potential helper for every other thread.

The consequence is that no thread can be starved. Even if a thread gets preempted immediately after publishing its intended operation and never runs again for a long time, the other threads will see its announcement and complete the work for it. When the preempted thread eventually resumes, it finds its operation already done and can move on. That is the wait-free guarantee at the algorithm level.

The cost of helping is also real. It adds overhead to every operation, since every thread must scan the announcement table before doing its own work. It also complicates the implementation significantly, because completing another thread's operation means reasoning about partial state that someone else left behind. This is why wait-free data structures in the literature, the Kogan-Petrank wait-free queue being the canonical example, are substantially more complex than their lock-free equivalents, and why you rarely see them in production code unless the latency guarantee is a hard requirement.

The fetch_add counter sidesteps all of this because the hardware provides the helping for free. That makes it a useful demonstration of the instruction-level difference between lock-free and wait-free, but it should not be taken as representative of what wait-free algorithm design actually looks like at scale.

## Lock-Free and Wait-Free Beyond the Counter

A single atomic counter is a useful benchmark but a narrow lens. Lock-free and wait-free are guarantees that apply to whole algorithms and data structures, and the space of structures with these guarantees is worth knowing.

The most widely studied lock-free data structures are stacks and queues. The Treiber stack (1986) is the canonical lock-free stack: push and pop both use a CAS on the head pointer to swing the stack top atomically. If another thread changes the head between a thread's read and its CAS, the CAS fails and retries. That retry loop is exactly the lock-free guarantee: at least one thread's CAS succeeds on each contention round, and the system makes progress even if individual threads keep retrying. The Michael-Scott queue (1996) extends this to a two-lock-free-pointer design covering both head and tail, which is the basis for many production lock-free queues. Both structures are lock-free but not wait-free: a thread can retry an unbounded number of times under adversarial scheduling.

The gap between a lock-free operation and a lock-free algorithm matters. `std::atomic<T>::fetch_add` being lock-free means the single operation completes without blocking. But a data structure built on top of multiple atomic operations is not automatically lock-free just because each individual atomic is. A stack that uses one atomic for the head and another for a size counter, with no overall coordination guarantee, can have a window where neither pointer reflects a consistent state. Lock-free is a property of the algorithm as a whole, not a consequence of using lock-free primitives inside it.

Wait-free data structures are rarer and more constrained. The clearest practical examples are single-producer single-consumer ring buffers. When the ring buffer has a fixed capacity and producer and consumer each own exactly one pointer (write index and read index respectively), both operations complete in a constant number of steps with no contention between them regardless of what the other thread does. That is wait-free by construction: the producer never contends with the consumer, and vice versa. SPSC queues appear everywhere in high-frequency trading systems for exactly this reason, one ring buffer per producer-consumer pair, each pair wait-free, no retry anywhere in the hot path.

Most of what gets called "lock-free" in production code is the Treiber stack and Michael-Scott queue tier: lock-free algorithms built from CAS loops that give system-wide progress guarantees but offer no per-thread completion bound. The truly wait-free structures, beyond trivial operations like `fetch_add` and SPSC queues, appear mainly in research contexts or in systems where the tail latency of an individual thread missing its deadline is a hard failure condition.

## The Instruction-Level Difference

```cpp
// wait-free: one instruction, every thread done in one step
counter.fetch_add(1, std::memory_order_relaxed);

// lock-free: CAS loop, a thread can retry an unbounded number of times
int old = counter.load(std::memory_order_relaxed);
while (!counter.compare_exchange_weak(old, old + 1, std::memory_order_relaxed));
```

Godbolt confirms the generated code directly:

```asm
wait_free_increment():
        lock add        DWORD PTR counter[rip], 1   ; one instruction, always completes = wait-free
        ret                                          ; LOCK prefix = cache-line level, not a mutex

lock_free_increment():
        mov     eax, DWORD PTR counter[rip]
.L4:
        lea     edx, [rax+1]
        lock cmpxchg    DWORD PTR counter[rip], edx  ; atomic compare-and-swap
        jne     .L4                                   ; retry if another thread won the race
        ret                                           ; jne is what makes this lock-free not wait-free
```

The LOCK prefix on both instructions is cache-line level serialization, not a software mutex. When a thread executes `lock add` or `lock cmpxchg`, the CPU needs exclusive ownership of that cache line before completing the operation. Every other core holding a copy of that line has to invalidate its copy first, which is the MESI protocol's exclusive state transition. That invalidation round-trip is real cost, just a much cheaper and more localized one than anything involving the kernel or a system-wide lock.

## Checking This at Compile Time

The C++ standard does not require `std::atomic` to be lock-free at all. For types larger than the machine's native word size, or types that do not meet the alignment guarantees an implementation needs, it is allowed to fall back to an internal mutex to make the operations atomic. The type still compiles, still behaves correctly, and is still called `std::atomic`, it is just not lock-free, let alone wait-free.

Two standard tools exist to check this instead of assuming:

```cpp
std::atomic<int> a;
a.is_lock_free();                        // runtime check, C++11
std::atomic<int>::is_always_lock_free;   // compile-time constant, C++17
```

`is_lock_free()` is a runtime member function because the answer can depend on alignment and the specific hardware the binary ends up running on. `is_always_lock_free` is a compile-time `constexpr bool` added in C++17 for the common case where the answer is knowable at compile time, useful for a `static_assert` instead of discovering at runtime that a supposedly atomic counter is quietly taking a mutex on every call. On x86-64, `std::atomic<int>` is essentially always lock-free. A `std::atomic` wrapping a struct that spans multiple cache lines is a different story, and that is exactly the case this check exists for.

Note that neither of these tells you whether an operation is wait-free. The standard has no annotation for that. `is_lock_free()` confirms the implementation does not use a hidden mutex, which is a necessary but not sufficient condition for wait-free. Whether a specific operation is wait-free still requires looking at the generated assembly on the target platform.

## Memory Ordering: Why Relaxed is Right Here

Both the `fetch_add` and the `compare_exchange_weak` in the benchmark use `std::memory_order_relaxed`. This is intentional and worth explaining, because relaxed is often treated as a suspicious choice that might be hiding a bug.

Relaxed ordering means the atomic operation itself is atomic, but no synchronization relationship is established with other threads. There is no happens-before guarantee, no requirement that other threads see any particular ordering of memory operations around this one. For a throughput counter where the only invariant is that each increment is atomic and the final value does not need to coordinate any other memory, relaxed is exactly the right choice. There is no other data being protected by this atomic, no flag being set alongside it, no pointer being published through it. Just a number going up.

On x86, relaxed has an additional property worth knowing: it does not produce weaker hardware instructions. The `lock add` and `lock cmpxchg` instructions are the same regardless of whether the C++ source specified `relaxed`, `acquire`, `release`, or `seq_cst`. What changes between memory orders on x86 is not the instruction, but whether the compiler inserts a full memory fence around it. `seq_cst` adds an `mfence` or equivalent after the operation. `relaxed` does not. For a counter with no surrounding memory that needs ordering, the fence is pure overhead with no correctness benefit. Using `seq_cst` here would add a fence on every increment and measure something different from what the benchmark intends.

This does not mean relaxed is always safe. The moment an atomic is used to synchronize other memory, publishing a pointer that other threads will dereference, or setting a flag that guards access to non-atomic data, relaxed is wrong and the resulting code has a data race. The rule is not "relaxed is fine" but "relaxed is fine when the only invariant is the atomicity of the operation itself and nothing else needs ordering around it." A counter that only needs to count fits that description exactly.

## This Guarantee Depends on the Architecture

Everything said so far about `lock add` being a single wait-free instruction is a statement about x86. It is not a statement about C++, and it does not hold universally.

ARM cores before the ARMv8.1 Large System Extensions have no direct fetch-and-add instruction. The compiler implements `fetch_add` there with a load-exclusive, store-exclusive pair, LDXR and STXR, wrapped in a retry loop: load the value, mark the cache line as exclusively watched, compute the new value, attempt to store it, and retry the whole sequence if the store-exclusive reports something else touched the line in between. Structurally, that is the same shape as the CAS loop in the lock-free example, a loop that can retry an unbounded number of times under contention. The exact same C++ line, `counter.fetch_add(1)`, is wait-free on x86 and only lock-free on pre-LSE ARM.

ARMv8.1 closed this gap by adding true single-instruction atomics, LDADD among them, giving newer ARM cores the same one-instruction wait-free behavior x86 has had with `lock add` all along. The point is not that ARM is worse. It is that the wait-free guarantee demonstrated in the assembly here is a property of the compiled instruction sequence on a specific target, not something the C++ standard hands you for free just because you wrote `fetch_add` instead of a `compare_exchange` loop. If a system is being built where the wait-free guarantee matters for correctness, checking the generated assembly on the actual deployment target is not optional.

## Why This Matters Beyond Throughput

The benchmark numbers make wait-free look good mostly because it is fast. That is not the main reason wait-free guarantees matter in practice, and framing it purely as a throughput story understates the point.

A mutex creates a scheduling dependency between threads that have nothing else to do with each other. If a low-priority thread holds a lock and gets preempted, a high-priority thread waiting on that same lock is stuck until the low-priority thread runs again, and if some third, medium-priority thread keeps preempting the low-priority one in the meantime, the high-priority thread can end up waiting far longer than its priority should ever allow. This is priority inversion, and it is not a theoretical concern. It is the bug that caused the Mars Pathfinder rover to reset itself repeatedly in 1997, eventually traced to exactly this pattern and fixed by enabling priority inheritance on the mutex involved.

Lock-free code eliminates blocking, but not starvation. A thread stuck in a retry loop is not blocking on another thread in the kernel sense, but it is making no progress as long as the CAS keeps failing. Under adversarial scheduling, that can be indefinite.

Wait-free code has no scheduling dependency between threads at all. No thread ever waits on another thread's progress, so there is nothing for a lower-priority thread to block by holding. This is why wait-free structures matter in hard real-time systems and in latency-sensitive trading systems, where a single stalled thread on the wrong side of a scheduling decision is the difference between a predictable tail latency and an unbounded one. The throughput number in this post's benchmark is a side effect. The guarantee that no thread can ever be blocked or starved by another thread's scheduling, regardless of what the OS decides to do, is the point.

## Run: benchmark.cpp

```bash
g++ -O2 -std=c++20 -pthread benchmark.cpp -o benchmark
```

`-O2` is the standard optimization level used across this repo. `-pthread` is required on Linux with GCC whenever `std::thread` is used.

Run each mode as its own process, at both thread counts, separately:

```bash
./benchmark no-sync max
./benchmark mutex max
./benchmark lock-free max
./benchmark wait-free max
./benchmark no-sync 2
./benchmark mutex 2
./benchmark lock-free 2
./benchmark wait-free 2
```

Running each mode as a separate invocation keeps cache state, thread scheduling, and OS noise from one mode from bleeding into the next. The `max` argument uses `hardware_concurrency()` to match the actual machine. `2` gives a low-contention comparison showing how the modes behave when threads rarely collide.

For hardware counter data on each mode:

```bash
sudo sysctl -w kernel.perf_event_paranoid=1
```

This kernel setting controls how much access non-root users have to performance monitoring counters. Setting it to 1 allows process-level counter access without running perf as root. Revert after this session:

```bash
sudo sysctl -w kernel.perf_event_paranoid=4
```

```bash
perf stat -e cycles,instructions,cache-misses ./benchmark no-sync max
perf stat -e cycles,instructions,cache-misses ./benchmark mutex max
perf stat -e cycles,instructions,cache-misses ./benchmark lock-free max
perf stat -e cycles,instructions,cache-misses ./benchmark wait-free max
```

`cycles` and `instructions` together give instructions-per-cycle across the full run. `cache-misses` shows the cache coherence traffic each mode generates, but the relationship between synchronization mechanism and cache miss count is not as straightforward as it might seem. See the perf analysis section below for what the actual results show and why they contradict the intuitive ordering.

## Output

Full per-thread counts are in the GitHub README. The numbers that matter for the analysis are the summary stats.

**16 threads (max contention), 5s run:**

| mode      | throughput     | min/thread | max/thread | spread |
|-----------|----------------|------------|------------|--------|
| no-sync   | 75.3M ops/sec  | 17.1M      | 68.9M      | 302%   |
| wait-free | 69.8M ops/sec  | 17.6M      | 26.2M      | 49%    |
| lock-free | 20.9M ops/sec  | 4.4M       | 8.3M       | 86%    |
| mutex     | 16.9M ops/sec  | 5.1M       | 5.3M       | 4%     |

**2 threads (low contention), 5s run:**

| mode      | throughput      | min/thread | max/thread | spread |
|-----------|-----------------|------------|------------|--------|
| no-sync   | 280.1M ops/sec  | 697.1M     | 703.5M     | 0%     |
| wait-free | 62.5M ops/sec   | 155.3M     | 157.2M     | 1%     |
| mutex     | 30.1M ops/sec   | 71.1M      | 79.4M      | 11%    |
| lock-free | 24.8M ops/sec   | 60.7M      | 63.5M      | 4%     |

## What the Numbers Show

The throughput ordering at 16 threads is: no-sync (75.3M ops/sec), wait-free (69.8M), lock-free (20.9M), mutex (16.9M). No-sync leading is not surprising once you remember it has no LOCK prefix anywhere, no atomicity overhead of any kind, just racy writes that happen to complete fast. The final counter value is meaningless, but the throughput is the theoretical ceiling for this machine on this operation. Wait-free comes in close behind despite the LOCK prefix cost on every call, because `lock add` is a single cache-line operation and the total work done is enormous: 348M increments in 5 seconds across 16 threads.

Lock-free and mutex landing nearly identical at 16 threads, 20.9M vs 16.9M, directly contradicts the assumption that lock-free always beats a mutex. Under 16 threads hammering a single shared counter, the CAS retry loop burns cycles on failed attempts at roughly the same rate as the mutex burns cycles on serialization. For every successful increment counted in the output, there are multiple failed CAS attempts happening simultaneously: each failed attempt still costs a full cache line invalidation round-trip before the retry, so the CPU is doing significant work that never shows up in the completion count. The workload here maximizes the disadvantage of both: a single shared memory location with no other work to overlap with synchronization cost.

The 2-thread runs flip the ordering between mutex and lock-free in a useful way. Mutex at 2 threads reaches 30.1M ops/sec while lock-free reaches only 24.8M. Mutex beats lock-free at lower contention too, and by a larger margin. At 2 threads, the kernel path inside the mutex is rarely hit since one thread is usually not waiting when the other releases. Mutex overhead reduces to a few atomic operations on the lock word itself, which is cheaper than even a lightly-contended CAS loop on this workload. Lock-free never beats mutex here at any thread count, because the operation being synchronized, a single integer increment with nothing else inside the critical section, is the worst case for CAS-based synchronization. Workloads with more work inside the critical section, or more threads operating on distinct parts of a structure rather than one shared counter, are where lock-free's scalability advantage shows up.

Wait-free is the clear winner at both thread counts: 69.8M at 16 threads and 62.5M at 2 threads. It does not collapse under contention the way lock-free does, and it does not pay kernel costs the way mutex does.

The per-thread spread numbers show what the guarantees actually mean under load. At 16 threads, lock-free shows 86% variance: thread 6 completed 4.4M ops while thread 0 completed 8.3M on the same workload, caused directly by which threads kept winning the CAS and which kept retrying. At 2 threads, lock-free's spread collapses to 4%. This proves the spread is contention-driven: fewer threads means fewer collisions, fewer collisions means fewer retries, fewer retries means less variance between winners and losers.

Wait-free's 49% spread at 16 threads is not caused by retries, `fetch_add` has none. It is caused by hardware topology: threads 0 through 3 and 12 through 15 consistently land around 25M to 26M ops, while threads 4 through 11 land around 17M to 18M. Those groups correspond to different physical cores on this CPU, and the OS scheduler distributed threads across them unevenly. At 2 threads on two logical cores of the same physical core, hardware asymmetry disappears and spread collapses to 1%. The wait-free guarantee holds in both cases, no thread retried, no thread was starved by another thread's behavior, but the hardware is not symmetric and the numbers reflect that regardless of what the synchronization mechanism promises.

No-sync's 302% spread at 16 threads, where thread 2 alone completed 68.9M ops while thread 7 completed 17.1M, shows what happens when cache line ownership bounces between cores with zero coordination. There is no LOCK prefix to serialize access, so whichever core happened to hold the line in a modified state at the right moment could complete increments at full speed while others waited for the transfer. At 2 threads the spread drops to 0% because with only two threads rarely hitting the line simultaneously, the uncoordinated writes almost never collide and each thread gets roughly equal access to the line. No-sync at 2 threads reaching 280M ops/sec is the throughput ceiling: what the machine can do with no synchronization cost at all, just raw integer increments.

## perf stat output

Full raw output is in the GitHub README. Key counters across all four modes at 16 threads:

| mode      | cycles  | instructions | cache-misses | IPC   | user   | sys    |
|-----------|---------|-------------|--------------|-------|--------|--------|
| no-sync   | 318.8B  | 2.05B       | 537.4M       | 0.006 | 76.2s  | 0.11s  |
| wait-free | 327.8B  | 2.08B       | 629.7M       | 0.006 | 78.5s  | 0.05s  |
| lock-free | 318.8B  | 2.46B       | 156.7M       | 0.008 | 76.3s  | 0.08s  |
| mutex     | 202.2B  | 52.5B       | 435.7M       | 0.259 | 7.6s   | 53.9s  |

IPC is instructions divided by cycles, derived from the counters above.

## What perf Reveals

Cache misses settle the coherence question directly, and the ordering is not what intuition suggests. No-sync produced 537M misses and mutex produced 435M, close to each other despite one having zero synchronization instructions and the other fully serializing every increment. No-sync's misses come from racy writes bouncing the cache line between cores with no LOCK prefix involved at all. Invalidation does not require an atomic instruction, it only requires a write to a line another core has cached, which is exactly what sixteen threads hammering a plain int does. Lock-free produced 156M cache misses, the lowest of all four modes by a wide margin. Wait-free produced 629M, the highest.

Lock-free's low miss count makes sense once contention is accounted for. `compare_exchange_weak` reads a local snapshot before attempting the write, and under this contention pattern, a meaningful share of retries resolve against a value already in a thread's own cache before the next attempt touches the shared line again. Not every failed CAS triggers fresh coherence traffic the way a successful LOCK-prefixed write does. Wait-free's `fetch_add` has no such local step, every single call is an unconditional `lock add`, and wait-free completed roughly 3.4 times more total operations than lock-free in the same 5 seconds (354M vs 102M). The high miss count on wait-free is not a hidden cost making it worse, it is a direct consequence of successfully doing far more coherence-generating work in the same window.

The instruction count adds another layer. Lock-free produced 2.46B instructions against wait-free's 2.08B, a 20% higher instruction count despite completing 3.4 times fewer successful operations. Those extra instructions are entirely retry overhead: every failed CAS attempt still executes the load, the add, the cmpxchg, and the conditional branch before looping back. The instruction counter makes the retry tax visible in a way the throughput number alone hides.

The IPC numbers across no-sync, wait-free, and lock-free are striking: 0.006, 0.006, and 0.008 respectively. A modern out-of-order CPU typically runs at 2 to 4 IPC on well-pipelined integer work. Getting 0.006 means the CPU is completing roughly one instruction every 160 cycles. That is the cache miss penalty made visible in aggregate: 16 cores all fighting for exclusive ownership of the same 64-byte cache line means nearly every memory access stalls for a full MESI round-trip, and the CPU sits idle waiting for the transfer on almost every instruction that touches that line. The synchronization mechanism barely changes this: no-sync, lock-free, and wait-free all land at the same order of magnitude IPC because they all have the same fundamental bottleneck, one cache line being passed between 16 cores as fast as the interconnect allows.

Mutex's sys time makes its cost location explicit in a way cache misses and IPC cannot. Mutex spent 53.9 seconds in kernel time summed across its threads, while every other mode spent under 0.12 seconds. That is where mutex's cost actually lives, not in cache coherence at the hardware level, but in threads blocking and getting rescheduled by the kernel every time they fail to acquire the lock. This also explains mutex's anomalous IPC of 0.259, more than 30 times higher than the other modes: most threads are sleeping, so the total cycle count is lower (202B vs 318B for the others), and the instructions being counted skew toward kernel-side work that runs more efficiently than a hot loop stalling on a contended cache line. Cache misses measure hardware-level contention cost. Sys time measures OS-level contention cost. Mutex pays almost entirely in the second currency. The other three modes pay almost entirely in the first.

## Quick Reference

**Coming from other languages**

Most languages that expose atomic operations expose this same distinction at the API level, even if the names differ. An operation that maps to a single hardware instruction with no retry path is wait-free regardless of what language wraps it. An operation that involves a loop around a compare-and-swap is lock-free at best, since the loop means no individual thread is guaranteed to complete in any fixed number of steps. Below both sits obstruction-free, progress only if a thread runs without interference, which some optimistic concurrency models rely on entirely. None of this is fixed by the language layer. The same C++ line can carry a different guarantee on different hardware, since the guarantee is a property of the compiled instruction sequence on the target processor. And even when an operation is wait-free, the bound on completion steps matters: a constant bound and a linear-in-threads bound are both wait-free, but they are not the same thing in practice.

**The 90% mental model**

If an atomic operation has no retry loop, it is wait-free: every thread completes in a bounded number of steps, no thread can be starved by another. If it has a retry loop, it is lock-free at best: the system makes progress because someone wins each round, but any individual thread might lose repeatedly. The lock in lock-free is about software locks and mutexes, not the LOCK prefix in the assembly, which is cache-line level hardware serialization and a completely separate layer. The guarantee a given line of code carries depends on what the compiler turns that line into on the target processor, not on which C++ API you called.
