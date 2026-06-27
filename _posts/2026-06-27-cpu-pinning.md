---
layout: post
title: "CPU Pinning: Why Moving a Thread Costs More Than It Looks"
date: 2026-06-27
domain: cpu
permalink: /blog/cpu/cpu-pinning/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/cpu/cpu-pinning"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7476476921942298624-BGwy"
---

An OS thread that gets moved to a different core does not just change which CPU is running it. It loses everything that core had already warmed up for it.

## Why Migration Has a Real Cost

Every core has its own L1 and L2 cache. A thread running on one core for a while fills that cache with exactly the data it keeps touching, fast access, no trip to RAM. The moment the scheduler moves that thread to a different core, all of that is gone. The new core has cold caches for that thread's data, and rebuilding what the old core already had ready costs full cache miss latency, paid all at once right after the move.

CPU pinning exists entirely because of this. Pin a thread to a specific core and the scheduler is no longer allowed to move it based on whatever else is happening on the system. The cache stays warm because the thread never leaves.

This matters more as core count goes up and contention for cores increases. A thread getting preempted and rescheduled elsewhere is not free just because the new core happens to be idle. It is a trade of idle time for a cold cache, and depending on the workload, that trade can be worse than just waiting.

## How Pinning Actually Works

Pinning a thread means setting its CPU affinity mask, telling the kernel which specific cores that thread is allowed to run on. Once set, the scheduler is constrained to that mask, regardless of load elsewhere on the system.

```cpp
#include <pthread.h>

void pin_to_core(std::thread& t, int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);           // clear the mask
    CPU_SET(core_id, &cpuset);   // allow only this one core
    
    pthread_setaffinity_np(
        t.native_handle(),       // the OS thread handle
        sizeof(cpu_set_t),
        &cpuset                  // apply the mask: pin it
    );
}
```

`CPU_ZERO` clears the mask to start from nothing allowed. `CPU_SET` adds exactly one core to that mask. `pthread_setaffinity_np` applies the mask to a specific OS thread handle, obtained here through `native_handle()` on a `std::thread`. The same mechanism works at the process level from the shell with no code involved at all:

```bash
taskset -c 3 ./my_program
```

This pins the entire process to core 3 for its whole lifetime, useful when the binary cannot be modified directly or when pinning is being tested without touching source code first.

## What the Code Demonstrates

### migration-cost.cpp: Forcing the Scenario Instead of Waiting for It

Waiting for the OS scheduler to migrate a thread naturally, on a lightly loaded machine, might rarely happen at all, which would make a demo relying on it unreliable from one run to the next. `migration-cost.cpp` forces the exact scenario directly instead. One mode pins a worker thread to one core for the entire run. The other mode starts pinned, then explicitly flips affinity between two specific cores at a fixed interval throughout the run, simulating a thread the scheduler keeps bouncing around.

```cpp
constexpr long long kPasses = 4000;
constexpr size_t kWorkingSetBytes = 256 * 1024; // fits in L2, exceeds L1
constexpr long long kMigrationIntervalPasses = 50;
```

Both modes repeatedly sweep over the same fixed-size array, sized deliberately to fit comfortably inside L2 but exceed L1 on this CPU. A working set that already fit entirely in L1 everywhere, or one far larger than any cache level, would not show this difference clearly. The size here is chosen specifically so the array benefits from staying resident in a core's L2 cache across repeated passes, and so that losing that residency after a migration is the actual cost being measured, not something masked by the array being trivially small or hopelessly large either way.

```cpp
long long touch_working_set(std::vector<int>& data) {
    long long sum = 0;
    for (size_t i = 0; i < data.size(); ++i) {
        data[i] = data[i] * 3 + 1;
        sum += data[i];
    }
    return sum;
}
```

In `migrating` mode, the worker thread flips its own affinity at a fixed interval:

```cpp
if (std::strcmp(argv[1], "migrating") == 0 &&
    pass > 0 && pass % kMigrationIntervalPasses == 0) {
    currently_on_a = !currently_on_a;
    set_affinity(pthread_self(), currently_on_a ? core_a : core_b);
}
```

Right after each forced migration, the new core's cache has never seen this array. The first several passes after migrating have to rebuild that residency from a colder cache state, or from RAM directly, which is exactly the cost the post describes happening in practice on a scheduler-driven migration, made deterministic and repeatable here instead of left to chance.

### Confirming the Core Pair Is Separate

The two cores used for migration have to be separate physical cores, not two SMT threads of the same physical core sharing the same cache already. Picking a pair like that would defeat the demo entirely, since there would be little or no cache to actually lose between them.

```bash
lscpu -e
```

This lists every logical CPU on the machine along with its `CORE` column. Two CPU numbers sharing the same `CORE` number are SMT threads of one physical core, sharing L1, L2, and usually L3 entirely. On this machine, `lscpu -e` showed CPU 0 and CPU 1 sharing CORE 0, an SMT pair that would have been the wrong choice here. CPU 0 (CORE 0) and CPU 4 (CORE 2) are confirmed separate physical cores with their own L1 and L2, and that is the pair actually set in the code:

```cpp
constexpr int core_a = 0;
constexpr int core_b = 4;
```

Running this on different hardware means re-running `lscpu -e` and updating these two constants to match a separate pair on that machine. The right pair is not guaranteed to be 0 and 4 everywhere, since core and SMT numbering varies between CPUs.

## Run: pin-to-core.cpp

```bash
g++ -O2 -std=c++20 -pthread pin-to-core.cpp -o pin-to-core && ./pin-to-core
```

`-O2` is the standard optimization level used across this repo. `-pthread` is required on Linux with GCC whenever `std::thread` is used.

## Run: migration-cost.cpp

Compile once:

```bash
g++ -O2 -std=c++20 -pthread migration-cost.cpp -o migration-cost
```

Run each mode as its own process, separately:

```bash
./migration-cost pinned
./migration-cost migrating
```

Running these separately, rather than back to back in one process, keeps any state from one run from influencing the other, the same separation used for every other good versus bad comparison in this repo.

For a closer look at cache behavior specifically:

```bash
sudo sysctl -w kernel.perf_event_paranoid=1
```

This kernel setting controls how much access non-root users have to performance monitoring counters. The default on most distros blocks or limits perf for regular users. Setting it to 1 allows process-level counter access without needing to run `perf` itself as root. This setting persists at the OS level beyond this one process, so revert it after this session:

```bash
sudo sysctl -w kernel.perf_event_paranoid=4
```

4 is the typical distro default that restricts perf access again. Check what the value actually was before changing it, in case a different default is in effect on a given machine.

```bash
perf stat -e cache-misses,cache-references,L1-dcache-load-misses,task-clock,cpu-migrations ./migration-cost pinned
perf stat -e cache-misses,cache-references,L1-dcache-load-misses,task-clock,cpu-migrations ./migration-cost migrating
```

`cache-misses` and `cache-references` give the overall miss rate, expected to land meaningfully higher for the migrating run. `L1-dcache-load-misses` isolates misses at the L1 level specifically. `cpu-migrations` confirms how many times the kernel actually moved the thread, useful for checking the forced affinity flips landed as migrations and not just an affinity mask change with no effect. `task-clock` shows how much of the wall clock time was actually spent running, useful for ruling out scheduling overhead as the explanation for any difference seen. Run this with nothing else competing for the CPU, background load changes what this comparison measures.

## Output

```
pinned: 132 ms, checksum = 380209871192064
migrating: 194 ms, checksum = 380209871192064
```

Migrating loses by roughly 1.47 times the wall clock of pinned, for a worker thread doing identical work over identical data.

## perf stat output

```
 Performance counter stats for './migration-cost pinned':
            87,445      cache-misses
        17,203,800      cache-references
        16,529,335      L1-dcache-load-misses
            134.23 msec task-clock
                  2      cpu-migrations
       0.135797385 seconds time elapsed
       0.133893000 seconds user
       0.001998000 seconds sys

 Performance counter stats for './migration-cost migrating':
           423,157      cache-misses
        18,444,980      cache-references
        16,592,846      L1-dcache-load-misses
            193.12 msec task-clock
                 80      cpu-migrations
       0.197597735 seconds time elapsed
       0.193030000 seconds user
       0.004021000 seconds sys
```

`cache-misses` is 87,445 for pinned against 423,157 for migrating, roughly 4.8 times more misses in the migrating run, while `cache-references` stayed close between the two, 17.2 million against 18.4 million. The miss rate itself went up under migration, not just the total number of accesses, which is the actual signal this demo was built to surface. `L1-dcache-load-misses` stayed essentially flat between the two runs, 16.53 million against 16.59 million, which fits the working set size chosen for this demo: 256KB was sized to exceed L1 and fit in L2 specifically, so the residency being lost and rebuilt on migration is residency at the L2 level, not L1.

`task-clock` tracks elapsed time closely for both runs, 134.23ms against 135.80ms elapsed for pinned, 193.12ms against 197.60ms elapsed for migrating, confirming the worker thread spent nearly all of its wall clock time actually running in both modes, not waiting to be scheduled. The slowdown is not scheduling overhead. `cpu-migrations` reads 2 for the pinned run, the thread's initial placement, against 80 for the migrating run, matching `kPasses / kMigrationIntervalPasses`, 4000 divided by 50, exactly. The forced affinity flips in the code landed as kernel-level migrations.

Cache misses, migration count, and wall clock time all point in the same direction here. The migrating thread paid a measurable cost in cache residency for being moved, and that cost shows up directly as extra wall clock time on an otherwise identical workload.

## Quick Reference

**Coming from other languages**

CPU affinity is an OS-level mechanism, not a language feature, so the same underlying capability exists regardless of which language a thread is created from. Every language that exposes OS threads sits on top of the same kernel scheduler and the same affinity mask mechanism, whether that gets exposed through a thin wrapper, a more abstracted API, or has to be reached through a lower-level system call directly. The cache-warmth cost being protected against here is a property of the CPU and the OS scheduler, not of any particular language's runtime.

**The 90% mental model**

A thread sitting on the same core builds up cache residency the longer it stays. Moving it anywhere, even to an idle core, throws that residency away and forces it to rebuild from a colder cache or from RAM. Pinning is the tool for keeping a thread's cache warm by keeping the thread in place, and it pays off most when a thread's working set is small enough to meaningfully benefit from staying resident in a specific core's cache, not in every situation by default.
