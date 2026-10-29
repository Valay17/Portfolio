---
layout: post
title: "Block Allocators and Memory Fragmentation"
date: 2026-10-28
domain: memory
permalink: /blog/memory/block-allocators/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/block-allocators"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7521047713006886914-yx7O/"
---

A program can have 100 MB of free memory and still have to grow by 400 MB to satisfy its next allocation. The memory is not lost. It is split into holes, and every hole is smaller than the request. A block allocator avoids this by never mixing sizes, and it does so with a free list that costs no extra memory.

## How the Heap Ends Up in Pieces

`malloc` carves every block out of one shared region, the heap. `free` returns a block to the allocator, but the neighbors of that block stay where they are. If both neighbors are also free, the allocator can merge the three into one larger hole. If a neighbor is live, the hole stays exactly as big as the block that was freed.

That is external fragmentation. The total free bytes can be large, but the bytes are scattered, and a request needs one contiguous run. Holes between live objects cannot merge until those objects go away.

There is a second cost. glibc only gives memory back to the operating system from the top of the heap. A free hole in the middle stays in the process, so resident memory (RSS) does not drop when it is freed. The process keeps paying for it until something fits.

## The Connection Scenario

Take a server setting up 100,000 connections. Each connection gets a 1 KB scratch buffer used during setup and a 64-byte session object that lives as long as the connection. They are allocated back to back, so memory alternates: scratch, session, scratch, session.

When setup finishes, every scratch buffer is freed. That releases about 100 MB, but as 100,000 separate holes of about 1 KB, each sitting next to a live session object. Nothing can merge them.

The next stage allocates a new buffer for every connection. `fragmentation.cpp` runs this sequence with the size of the new buffers taken from the command line:

```bash
g++ -std=c++20 -O2 fragmentation.cpp -o fragmentation
./fragmentation 1024
./fragmentation 4096
```

```
next buffers of 1024 B: RSS after setup 115264 KB, after freeing scratch 115388 KB, after 100000 new buffers 115388 KB (grew 0 KB, 0 MB)
next buffers of 4096 B: RSS after setup 115328 KB, after freeing scratch 115452 KB, after 100000 new buffers 517012 KB (grew 401560 KB, 392 MB)
```

Freeing the scratch buffers does not lower RSS. The 100 MB of holes stays with the process.

At 1 KB, each new buffer is the same size as a hole, so it drops straight into one and the process does not grow. At 4 KB, no hole is large enough. Every buffer needs fresh memory from the top of the heap, and the process grows by 392 MB, which is about the full cost of 100,000 buffers of 4 KB.

Sizes that sit close to the hole size behave in between, and those were not measured here. The two endpoints are enough to show the mechanism.

## The Block Allocator

A block allocator, also called a pool allocator, reserves one region up front and cuts it into equal chunks. Each chunk is the size of one object. Free chunks sit on a singly linked list.

The detail that makes it cheap is where the list lives. A free chunk is unused memory, so the allocator stores the next pointer inside the chunk itself:

```cpp
class PoolAllocator {
    struct Node { Node* next; };          // stored inside a free chunk, so no extra memory
    Node* free_list = nullptr;

public:
    PoolAllocator(char* region, size_t chunk_size, size_t count) {
        // cut the region into equal chunks and put every one on the free list
        for (size_t i = 0; i < count; ++i)
            deallocate(region + i * chunk_size);
    }

    void* allocate() {
        if (!free_list) return nullptr;   // pool exhausted
        Node* p = free_list;
        free_list = free_list->next;      // pop the first chunk, no search
        return p;
    }

    void deallocate(void* p) {
        Node* n = static_cast<Node*>(p);
        n->next = free_list;              // push the chunk back on the list
        free_list = n;
    }
};
```

Allocation pops the head of the list. Freeing pushes onto it. Neither looks at any other chunk, so there is no search and no merging, and no system call after the region is reserved.

The chunk size has two constraints. It must be at least `sizeof(Node*)`, so a free chunk can hold the next pointer. It must also be a multiple of the alignment the objects need, or every chunk after the first is misaligned. Objects are built into a chunk with placement new, the same separation between raw bytes and object lifetime that the allocator interface draws.

`pool.cpp` checks the list behavior with a pool of four chunks:

```bash
g++ -std=c++20 -O2 pool.cpp -o pool
./pool
```

```
fifth is null: 1, distinct: 1
freed chunk reused: 1
```

Four requests return four distinct chunks. The fifth returns `nullptr`. A chunk freed back is the next one handed out.

In the connection scenario, the scratch buffers get their own pool:

```cpp
PoolAllocator scratch_pool(1024, 100000);   // one region, cut into 100,000 chunks of 1 KB

for (int i = 0; i < 100000; ++i) {
    scratch[i] = scratch_pool.allocate();   // pop a chunk, no search
    session[i] = malloc(sizeof(Session));   // lives as long as the connection
}

for (int i = 0; i < 100000; ++i)
    scratch_pool.deallocate(scratch[i]);    // chunks go back on the free list, still whole

scratch[0] = scratch_pool.allocate();       // the next scratch buffer gets a whole 1 KB chunk
```

This snippet assumes a pool that reserves its own region. `pool.cpp` takes the region as an argument to keep the driver short, and the list logic is the same.

The scratch chunks never sit between session objects in the general heap, so the session objects cannot pin them in place. Nothing else can carve a pool chunk, and every freed chunk is the right size for the next scratch buffer.

## What a Pool Does Not Fix

A pool does not shrink the memory a program needs. It keeps one object size from being split into pieces by other sizes. `carving.cpp` shows both halves of that.

It frees the scratch buffers, optionally allocates 100,000 small 200-byte objects, then allocates a second wave of 1 KB buffers. The first argument picks where the scratch buffers came from, and the second says whether the small objects are allocated:

```bash
g++ -std=c++20 -O2 carving.cpp -o carving
./carving malloc 0
./carving malloc 1
./carving pool 1
```

```
malloc smalls=0 | after freeing scratch 116140 KB | after smalls 116264 KB (+124) | after 2nd wave of 1 KB 116268 KB (+4 KB = 0 MB)
malloc smalls=1 | after freeing scratch 116140 KB | after smalls 116264 KB (+124) | after 2nd wave of 1 KB 136580 KB (+20316 KB = 19 MB)
pool   smalls=1 | after freeing scratch 114580 KB | after smalls 135016 KB (+20436) | after 2nd wave of 1 KB 135016 KB (+0 KB = 0 MB)
```

With `malloc` and no small objects in between, the second wave reuses the holes. With the small objects, they settle into the holes first. The holes are left in pieces of the wrong size, and the second wave grows the process by 19 MB.

With the scratch buffers in a pool, the second wave grows the process by 0 KB, because every chunk is still whole. The small objects grow the heap by 20 MB instead, since they have no holes to settle into. The final RSS is close in both cases: 136580 KB with `malloc` and 135016 KB with the pool.

So the pool protects the 1 KB reuse, and the total stays about the same. It does not recover the 400 MB from the first scenario. That growth comes from asking for a size the free memory was never shaped to hold, and a pool for 4 KB buffers would need to exist before the fragmentation, not after it.

## Per-Block Bookkeeping

`malloc` has to find the size of a block when it is freed, so each block carries a header. `stride.cpp` makes that visible:

```bash
g++ -std=c++20 -O2 stride.cpp -o stride
./stride
```

```
malloc(16): addresses differ by 32 bytes, usable size 24
```

Two consecutive requests for 16 bytes land 32 bytes apart, and `malloc` reports 24 usable bytes in the first. On glibc x86-64 that is an 8-byte size field in front of each block plus rounding to 16-byte alignment, so a 16-byte request costs 32 bytes of heap.

A pool chunk in use carries nothing. The free-list pointer exists only while the chunk is free, and the pool knows every chunk's size because there is only one. The price is internal waste: if the objects are 40 bytes and the chunk is 48 for alignment, 8 bytes per chunk go unused, and no other object can use them.

## Thread Safety and the ABA Problem

The free list above is not safe to share between threads. Two threads can pop the same chunk.

The usual lock-free fix is a compare-and-swap on the head. A pop reads the head, reads the head's next pointer, then tries to swap the head from the old value to the next one:

```cpp
Node* old_head = head.load();
Node* next;
do {
    if (!old_head) return nullptr;
    next = old_head->next;
} while (!head.compare_exchange_weak(old_head, next));
return old_head;
```

This has an ABA hazard. Thread 1 reads head `A` and its next `B`, then stalls. Thread 2 pops `A`, pops `B`, and pushes `A` back. The head is `A` again, so thread 1's compare-and-swap succeeds. But `A->next` is no longer `B`, and `B` is in use by thread 2. Thread 1 installs `B` as the new head, and the list now contains a chunk that is live. The same pointer value reappearing does not mean the state is the same.

The common fixes are a version counter packed with the head pointer and swapped together (a double-width compare-and-swap, or an index plus counter in one word), hazard pointers, or avoiding sharing altogether with one pool per thread. The last one is what most production pools do.

## Arena Allocators

An arena, or bump allocator, is the simpler relative of the pool. It keeps one pointer into a region and advances it by the size of each request. There is no per-object free. The whole arena is released at once.

That fits allocations with a shared lifetime, such as everything created while handling one request in a server. It gives up reuse of individual objects for the lowest possible cost per allocation. `std::pmr::monotonic_buffer_resource` from the <a href="{{ site.baseurl }}/blog/memory/allocators/" target="_blank" rel="noopener noreferrer">the allocators post</a> is a standard-library arena, and `std::pmr::unsynchronized_pool_resource` is a standard-library pool with several size classes.

## Where Pools Already Exist

General-purpose allocators use the same idea internally. jemalloc and tcmalloc both keep per-thread caches of size-class pools, which cuts contention on shared heap structures. Neither was tested here, so no claim is made about how they behave on the scenarios above.

The Linux kernel applies the pattern to its own objects with the slab allocator. Each cache is a set of slabs, and each slab is a pool for one object type. The kernel has had three implementations, SLAB, SLUB and SLOB, with different space and speed tradeoffs. SLOB was removed in Linux 6.4 and SLAB in 6.8, leaving SLUB.

## Quick Reference

**Coming from other languages**

Environments with a managed heap can move live objects together to close holes, so fragmentation shows up as a pause or as extra memory rather than as an allocation that fails to fit. Where objects have fixed addresses, a hole stays a hole until its neighbors die. That is why the layout of allocations over time matters here, and why separating objects by size or by lifetime is a design decision made before the memory fragments, not a cleanup done after.

**The 90% mental model**

`malloc` serves every size from one heap. Freed blocks leave holes, holes between live objects cannot merge, and a request larger than every hole needs new memory even when the total free bytes would cover it. A pool allocator keeps one object size per region and threads a free list through the free chunks themselves. Allocate pops, free pushes, nothing searches, and a chunk in use carries no header. Because only one size ever lives there, a freed chunk always fits the next request. The cost is one pool per size, internal waste when the object does not fill its chunk, and a design decision about capacity and exhaustion made up front. A pool will not shrink a program that needs the memory, and a list shared across threads needs more than a bare compare-and-swap because of ABA.
