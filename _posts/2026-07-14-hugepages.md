---
layout: post
title: "Hugepages and the TLB: Fewer Pages, Fewer Misses"
date: 2026-07-14
domain: memory
permalink: /blog/memory/hugepages/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/hugepages"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7482561581856223232-8ZWI/"
---

Your CPU does not work with the memory addresses your code uses. It works with a translated version, and every translation costs time unless it is already cached. That cache is called the TLB (Translation Lookaside Buffer), and it is small. Hugepages exist to make the TLB's limited capacity cover more of your working set.

## The TLB and Why It Fills Up

Every memory access in your program goes through a translation from virtual address to physical address. The page table in the kernel holds the full mapping, but looking it up on every access would require several memory reads per instruction. The TLB caches recent translations so the hardware can resolve them in a single cycle.

The problem is capacity. A modern x86 CPU's L1 data TLB has around 64 entries. The L2 unified STLB typically has 1024 to 1536 entries. At 4KB pages, 1536 entries covers 1536 * 4KB = 6MB of memory. Any working set larger than that means the CPU has to evict TLB entries to make room, and every evicted entry that gets touched again requires a fresh translation.

That fresh translation is called a TLB miss, and the hardware has to walk the page table to resolve it. On x86-64, the page table has four levels: PGD, PUD, PMD, and PTE. A full walk reads four separate memory locations in sequence. If any of those locations are not in cache, each one is a separate cache miss. Four cache misses per TLB miss, potentially several hundred nanoseconds each. For code with a large working set and random access patterns, TLB misses can account for a significant share of total execution time.

## What Hugepages Do

A 2MB hugepage lets one TLB entry cover 512 times more memory than a 4KB page. The same 1536-entry STLB that covers 6MB at 4KB now covers 3GB at 2MB. A working set that blows through the entire TLB every few megabytes now fits comfortably within TLB capacity.

The page table walk also gets shorter. A 2MB hugepage only needs three levels to resolve (PGD, PUD, PMD), skipping the final PTE level entirely. Fewer levels means fewer potential cache misses per walk when a miss does occur.

The benchmark makes this concrete. A 1GB buffer divided into 4KB pages produces 262144 distinct pages. With 20 random-order passes over all of them, the benchmark touches 5242880 pages in a shuffled sequence. No page is ever the same as the next one, so the prefetcher cannot help, and the working set of 262144 pages far exceeds the TLB capacity of ~1536 entries. Nearly every access is a TLB miss.

The same 1GB buffer in 2MB hugepages produces only 512 distinct pages. 512 entries fits inside the STLB with room to spare. The random access pattern no longer causes TLB evictions because every page in the working set has a resident TLB entry.

## Transparent Huge Pages vs hugetlbfs

Two distinct mechanisms provide hugepages on Linux and they commit to them very differently.

Transparent Huge Pages (THP) is opportunistic. A mapping requests them with `madvise(buf, size, MADV_HUGEPAGE)`. The kernel uses 2MB pages for that region when it can, but it can decline if contiguous physical memory of that size is not available, and it can split a hugepage back into 4KB pages under memory pressure. The application sees no difference in the interface either way since it works with the same pointer and the same virtual addresses regardless of what page size backs them.

`hugetlbfs` is reserved. A pool of hugepages is pre-allocated system-wide at boot time or via `sysctl`, and that memory is removed from the general allocator entirely. Allocations from this pool are guaranteed to get hugepages and are never split or reclaimed. The cost is that the reserved memory is unavailable for anything else on the system until explicitly released. Applications use `MAP_HUGETLB` with `mmap` or the hugetlbfs filesystem mount to access the pool.

The benchmark uses THP since it requires no system configuration and is available to unprivileged processes. `hugetlbfs` would give stronger guarantees, relevant when THP availability is unpredictable at runtime, but needs the pool configured beforehand.

## What the Code Demonstrates

One file, two modes. Both allocate a 1GB buffer, touch every page once outside the timed section to eliminate page fault cost from the measurement, then make 20 passes in a shuffled random order touching one byte per page. The untimed prefault pass ensures that what is being measured is TLB pressure, not first-touch mapping cost. Sequential access would let the hardware prefetcher hide most of the TLB miss cost, so the shuffled order specifically isolates translation latency.

`normal` mode disables THP for the mapping with `MADV_NOHUGEPAGE`, ensuring 4KB pages regardless of system settings. `huge` mode requests THP with `MADV_HUGEPAGE`. Both are confirmed via `/proc/self/smaps`: `normal` shows 0 kB of `AnonHugePages`, `huge` shows the full buffer as hugepage-backed.

## Key Insight

```cpp
// allocate 1GB anonymously
void* buf = mmap(nullptr, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

// request 2MB hugepages for this mapping (THP, not guaranteed)
madvise(buf, size, MADV_HUGEPAGE);

// touch every byte to fault pages in before the timed section
memset(buf, 1, size);

// ... timed random-access passes ...

// release the mapping when done
munmap(buf, size);
```

`madvise` is a hint, not a command. The kernel can decline if 2MB-contiguous physical memory is not currently available. `munmap` is the correct release for `mmap`-allocated memory. Using `free()` on a pointer from `mmap` is undefined behavior since they use different underlying mechanisms.

## Run: both modes

```bash
g++ -O2 -std=c++20 benchmark.cpp -o benchmark
./benchmark normal
./benchmark huge
```

Run each mode as its own invocation so neither result is biased by TLB or page cache state left over from the other.

## Run: confirm THP is active

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
```

The active mode is shown in brackets. `madvise` means THP only applies when a mapping explicitly requests it, which is what this benchmark does. If this shows `[never]`, the `huge` mode will silently behave identically to `normal` since the kernel ignores `MADV_HUGEPAGE` when THP is disabled system-wide.

The benchmark reads `/proc/self/smaps` internally and prints `AnonHugePages` before each timed run. This confirms whether the kernel actually honored the hugepage request, since `madvise` is a hint and the kernel can fall back to 4KB pages if contiguous memory of the right size is unavailable. For `normal` mode the count should be 0 kB. For `huge` it should match the full buffer size.

## Output

```
$ ./benchmark normal
AnonHugePages: 0 kB
normal: 78378 us for 5242880 random page touches

$ ./benchmark huge
AnonHugePages: 1048576 kB
huge: 56741 us for 5242880 random page touches

$ cat /sys/kernel/mm/transparent_hugepage/enabled
always [madvise] never
```

`AnonHugePages: 0 kB` for normal confirms `MADV_NOHUGEPAGE` worked and the mapping is backed by standard 4KB pages. `AnonHugePages: 1048576 kB` for huge confirms the full 1GB buffer is backed by 2MB hugepages, 1048576 kB = 1GB. The confirmation comes from inside the process itself via `/proc/self/smaps`, so there is no shell timing race.

78378 vs 56741 microseconds, roughly 1.38x faster with hugepages. The mechanism matches the analysis. `normal` has 262144 distinct 4KB pages, far exceeding the STLB capacity of ~1536 entries, so nearly every random-order access requires a TLB miss and a page table walk. `huge` has 512 distinct 2MB pages, which fits entirely within the STLB. The 38% difference is the accumulated cost of those extra TLB misses and page table walks, measured directly on the same buffer doing the same work.

The absolute times vary between runs due to CPU boost and system state, but the direction and rough magnitude are consistent. The gap being 1.38x rather than the theoretical maximum reflects that TLB miss cost is one of several costs in a random-access memory pattern, not the only one.

## Connection to Previous Posts

This post sits between two others in the same memory thread.

The prefaulting post covered first-touch page faults: the kernel maps one physical page per fault, one page boundary at a time. Hugepages do not eliminate this mechanism, they reduce how often it triggers. 512 hugepage boundaries versus 262144 regular page boundaries means 512 total potential fault events for the same buffer, 99.8% fewer than the 4KB equivalent.

The NUMA post covered TLB shootdowns: when a page migrates to a different NUMA node, the kernel sends an IPI to every CPU with a stale TLB entry for that page. Hugepages reduce the blast radius directly. One 2MB hugepage migration requires invalidating one TLB entry per CPU. Migrating the equivalent 512 regular pages requires invalidating 512 entries per CPU. Same data movement cost, but the shootdown overhead scales with the number of TLB entries affected.

## Quick Reference

**Coming from other languages**

TLB capacity and translation miss cost are hardware properties that no language layer changes. Any runtime allocating large heap regions goes through the same virtual-to-physical translation mechanism. Garbage-collected runtimes that manage large heap arenas often use hugepages internally for exactly this reason, trading away fine-grained memory control for better TLB coverage of the heap. The application programmer usually does not see this. In C++, requesting hugepages is a one-line `madvise` call with no change to how the pointer is used, and the performance difference is directly measurable.

**The 90% mental model**

The TLB caches virtual-to-physical translations. It has a fixed number of entries, each covering one page. At 4KB pages, the TLB covers a few megabytes of memory at most. Any working set larger than that causes TLB misses, each of which requires a hardware page table walk costing multiple memory reads. Hugepages (2MB) let one TLB entry cover 512x more memory, fitting much larger working sets within TLB capacity. Transparent Huge Pages are requested with `madvise` and are opportunistic: the kernel tries to honor the request but can fall back to 4KB pages. `hugetlbfs` gives a hard guarantee by pre-reserving a pool, at the cost of that memory being unavailable for anything else.
