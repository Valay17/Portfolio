---
layout: post
title: "Lazy Allocation and the Cost of the First Touch"
date: 2026-07-09
domain: memory
permalink: /blog/memory/prefaulting/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/prefaulting"
linkedin: "https://linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7481112264813477888-Ojkq"
---

Calling `new` does not give you memory. It gives you a promise of memory. The OS reserves a range of virtual addresses, but no physical page backs any of it yet. The first time your code touches that memory, the hardware raises a page fault, the kernel steps in to do the actual mapping, and only then does your instruction continue. This cost is real, measurable, and invisible in the source.

## Virtual Memory and Why the OS Does This

Every address your program sees is a virtual address. The hardware translates it to a physical address on every access using the page table, a data structure the kernel maintains and the CPU's MMU (memory management unit) walks automatically. A virtual address range can be reserved without any physical memory behind it, and the OS exploits this deliberately.

When you call `new` or `malloc`, the allocator calls into the kernel via `brk` or `mmap`. The kernel reserves a range of virtual address space and returns the starting address. It does not allocate physical pages. It does not update the page table to map those addresses to anything real. It marks a range as belonging to your process and returns.

The reason is efficiency. Most programs allocate more than they use. A process that reserves 1 GB for a buffer it might fill to 100 MB would waste 900 MB of physical RAM if every page were mapped upfront. Deferring the physical mapping until a page is actually touched avoids wasting memory on pages nobody ever writes to. The cost of this is that the mapping has to happen somewhere, and it happens on first touch.

## The Page Fault Mechanism: What the Kernel Does

When your code accesses a virtual address with no physical page mapped behind it, the MMU cannot translate it and raises a page fault exception. The CPU stops executing your instruction and transfers control to the kernel's page fault handler.

The handler checks whether the faulting address is within a valid virtual memory region for your process. If it is (the normal case for a freshly allocated buffer), the kernel finds a free physical page, zeroes it (so your process cannot read another process's old data), updates the page table to map the faulting virtual address to that physical page, and returns control to the faulting instruction, which re-executes successfully.

This is a minor page fault: no disk I/O required, just a physical page to find and map. On a modern system this takes on the order of a few microseconds. For a 256 MB buffer at 4096-byte pages, that is 65536 faults, one per page, on first touch. The page fault does not appear in your source. It shows up as a memory access that takes longer than it should, in whatever context triggered the first touch. If that context is a latency-critical loop, the fault hits exactly there.

`getrusage(RUSAGE_SELF, &r)` exposes the fault count in `r.ru_minflt`. The benchmark uses this directly to confirm that faults land where expected and that the second pass produces zero.

## Prefaulting: Moving the Cost Before It Matters

The page fault is unavoidable. What you can control is when it happens.

Prefaulting means touching each page in a buffer before the hot path starts, forcing all the faults to happen during initialization rather than during latency-critical execution. One write per page is enough:

```cpp
char* buf = new char[size];

// prefault: touch every page, forcing the kernel to map physical memory now
for (size_t i = 0; i < size; i += page_size)
    buf[i] = 1;

// hot path: all pages already mapped, no faults here
for (size_t i = 0; i < size; i += page_size)
    buf[i] = 2;

delete[] buf;
```

Both loops touch the same addresses. Only the first pays the fault cost. The second finds every page already mapped and runs at full memory bandwidth. The benchmark output below shows what that difference looks like in numbers.

## mlock: Forcing Resident Pages

`mlock(buf, size)` makes the prefaulting explicit and adds a second guarantee. Calling it forces the kernel to map every page in the range immediately, moving the entire fault cost into the `mlock` call itself. It also pins those pages in physical memory, preventing the OS from swapping them out under memory pressure later.

```cpp
char* buf = new char[size];
mlock(buf, size);   // all faults happen here, pages pinned resident

// both passes from this point: no faults, no stalls, pages cannot be evicted
```

The "lock" in `mlock` means locked in RAM, not swappable. It is not a synchronization lock and has nothing to do with thread access control. The pages are still fully readable and writable after the call. The lock is also not permanent in the way that needs explicit cleanup: when the memory is freed with `delete[]` or `free()`, the OS removes the lock automatically since both eventually call `munmap` internally. `munlock(buf, size)` releases the pin explicitly if needed before freeing, allowing those pages to be swapped again. Either way, no separate unlock step is needed just to free the memory normally.

`mlock` requires `#include <sys/mman.h>`. It may need an elevated `RLIMIT_MEMLOCK` limit depending on the system. Pinned pages cannot be reclaimed by the kernel under memory pressure, so `mlock` is appropriate for buffers that need guaranteed low-latency access for the lifetime of the process, not for general use.

## Thread Stack Prefaulting

The thread stack has the same problem. When the OS creates a thread, it reserves a virtual address range for the stack but maps no physical pages. The first time a stack frame grows into a new page, a fault occurs. For a thread about to enter a latency-critical section, a deep call that pushes a new frame into an unmapped page stalls exactly when it cannot be afforded.

The fix is a startup function that deliberately touches the expected stack depth before the hot path begins:

```cpp
void prefault_stack() {
    constexpr size_t depth = 256 * 1024;  // tune to expected max call depth
    volatile char buf[depth];
    for (size_t i = 0; i < depth; i += 4096)
        buf[i] = 0;
}
// call once at thread startup, before entering the hot loop
```

The stack is also too small to be swapped out under normal memory pressure, so the eviction concern that makes `mlock` useful for heap buffers is less relevant here. The prefault is still necessary, but `mlock` on the stack is usually not.

## Run: default (no mlock)

```bash
g++ -O2 -std=c++20 benchmark.cpp -o benchmark
./benchmark
```

`page_size` comes from `sysconf(_SC_PAGESIZE)` rather than being hardcoded. `getrusage` and `mlock` are standard POSIX, no special flags needed.

```
$ ./benchmark
first touch:  121281 us, minor faults: 65537
second touch: 1015 us, minor faults: 0
```

~120x slower on first touch. Fault count lands at 65537, nearly exactly the predicted 65536 pages for a 256 MB buffer at 4096 bytes per page. The extra fault is the buffer's own allocation metadata page. Second touch: no faults, full memory bandwidth.

## Run: mlock mode

```bash
g++ -O2 -std=c++20 benchmark.cpp -o benchmark
./benchmark mlock
```

```
$ ./benchmark mlock
mlock: 115069 us, minor faults during mlock: 65538
first touch:  1071 us, minor faults: 0
second touch: 877 us, minor faults: 0
```

The entire fault cost moves into the `mlock` call. Both touch loops afterward run fault-free, indistinguishable from the plain run's already-warm second touch. First and second pass timings collapse to noise relative to each other.

## Quick Reference

**Coming from other languages**

Lazy allocation is an OS-level behavior, not a language-level one. Any runtime that allocates heap memory through the OS goes through the same virtual-to-physical mapping mechanism. Garbage-collected runtimes often prefault their heap regions at startup for exactly this reason: predictable pause times require that page faults do not show up inside a GC cycle. The difference is that the runtime hides this from the programmer. In C++, the programmer controls it directly, which is also the reason a C++ developer has to know it exists.

**The 90% mental model**

`new` reserves virtual address space. Physical memory only gets mapped on first touch, one page at a time, as a page fault the kernel handles invisibly. For most code this is fine. For latency-critical paths, it is a stall at the worst possible moment with no warning in the source. Prefault by touching every page before the hot path starts: one write per page, done during initialization. Use `mlock` to force immediate mapping and prevent eviction. Prefault thread stacks the same way, since they are lazily mapped for the same reason.
