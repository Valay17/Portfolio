---
layout: post
title: "A Lock-Free Queue That Still Waits on a Lock"
date: 2026-10-29
domain: memory
permalink: /blog/memory/allocator-contention/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/allocator-contention"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7521399016576937984-pu4v/"
---

A queue built on atomics can promise that a stalled thread never stops the others from finishing their operations. The allocator it takes nodes from usually cannot make the same promise. With glibc, a node allocated on one thread and freed on another can end up behind the same lock the next allocation needs. Counting `futex` system calls shows where the waiting happens, and moving allocation out of the hot path removes it.

## What Lock-Free Does Not Cover

As the <a href="{{ site.baseurl }}/blog/concurrency/lock-free-wait-free/" target="_blank" rel="noopener noreferrer">lock-free and wait-free post</a> defines it, lock-free means at least one thread finishes its operation in a bounded number of steps, even if the others stall or keep retrying. It is a property of the operations a structure performs. A push or pop that is a few atomic loads and one compare-and-swap loop can meet it.

A push that first builds a node with `new` is a different operation. It calls into the allocator, and whatever the allocator does is now part of the push. If the allocator takes a mutex and the thread holding it is descheduled, every thread that needs the mutex is stuck behind it. No thread is guaranteed to finish, and the guarantee no longer holds for the operation as a whole.

The standard does not treat this as a correctness problem. It requires the allocation and deallocation functions, including `operator new`, `operator delete`, `malloc` and `free`, to be safe to call from several threads at once. That is why `std::allocator`, which calls `operator new`, is safe to use from several threads. What the standard leaves open is whether those calls block. The cost is contention, not undefined behavior.

## Where glibc Takes the Lock

glibc keeps memory in arenas, and each arena has a mutex. The paths below are from the glibc 2.39 source, `malloc/malloc.c` and `malloc/arena.c`.

On `malloc`, a multithreaded process first checks the calling thread's tcache, a small per-thread cache of recently freed blocks. On a miss, `arena_get` locks the thread's arena, `_int_malloc` runs, and the arena is unlocked. Every allocation that misses the tcache takes the arena mutex, whether or not anyone else wants it.

On `free`, the arena is not chosen by the calling thread. `free` finds the arena the block came from, using the chunk's header, and calls `_int_free` on that arena. Inside `_int_free` the checks run in this order:

1. If the size class is eligible and that bin of the calling thread's tcache holds fewer than 7 chunks, the chunk goes into the tcache.
2. Otherwise, if the chunk is small enough for a fastbin, it is pushed onto the fastbin with an atomic compare-and-swap. No lock is taken.
3. Otherwise, the arena mutex is taken and the chunk is merged with its neighbors and binned.

The defaults decide who gets which path. The fastbin limit is 128 bytes of chunk size on 64-bit (`DEFAULT_MXFAST` is `64 * SIZE_SZ / 4`). A chunk carries an 8-byte header and rounds up to a multiple of 16, so a 64-byte request becomes an 80-byte chunk and qualifies. A 128-byte request becomes a 144-byte chunk and does not. The tcache covers requests up to 1032 bytes, but only 7 chunks per size.

In a producer and consumer pair, the tcache does not help. The consumer frees, so its tcache fills with 7 blocks and everything past that falls through. The producer allocates, and in this benchmark its tcache stays empty because nothing is freed on its thread. Small blocks fall through to the lock-free fastbin push. Larger blocks take the owning arena's mutex, the same mutex the producer takes on its next allocation.

Two threads contending for a mutex is what makes the kernel get involved. An uncontended lock acquire is an atomic instruction in user space. A thread that finds the lock held sleeps through the `futex` system call. So `futex` calls count contention, not lock acquisitions. The producer in the small-node case still takes the mutex on every allocation. It just never finds it held.

## Measuring the Waiting

`futex.cpp` moves 1,000,000 nodes from a producer thread to a consumer thread through a lock-free single-producer single-consumer queue. In `malloc` mode the producer builds each node with `new` and the consumer calls `delete`. In `pool` mode every node the queue can hold is allocated before the threads start, and the consumer returns nodes through a second queue instead of freeing them. The node size is a command-line argument. The program checks the sum of the values the consumer receives and prints the number of voluntary context switches, which counts the times a thread slept and gave up the CPU.

```bash
g++ -std=c++20 -O2 -pthread futex.cpp -o futex
./futex malloc 64
./futex malloc 512
./futex pool 512
```

```
malloc, 64-byte nodes: sum ok, voluntary context switches 11
malloc, 512-byte nodes: sum ok, voluntary context switches 4567
pool, 512-byte nodes: sum ok, voluntary context switches 1
```

Every run delivered all 1,000,000 nodes. With 64-byte nodes the threads almost never sleep. With 512-byte nodes they sleep thousands of times, and with the pool they barely sleep at all.

`strace` counts the `futex` calls directly. `-f` follows the threads the program creates, `-c` prints a summary instead of every call, and `-e trace=futex` limits it to `futex`. Each command was run three times:

```bash
strace -f -c -e trace=futex ./futex malloc 64
strace -f -c -e trace=futex ./futex malloc 128
strace -f -c -e trace=futex ./futex malloc 512
strace -f -c -e trace=futex ./futex pool 512
```

```
malloc 64:  2 calls    2 calls    2 calls
malloc 128: 26497 calls    25423 calls    24107 calls
malloc 512: 103035 calls   99850 calls    107934 calls
pool 512:   3 calls    2 calls    2 calls
```

The two calls at 64 bytes are one wake during program startup and the main thread waiting in `join` for a worker thread to finish. At 128 bytes the count jumps by four orders of magnitude, and at 512 bytes it is higher again. With the pool it is back to two or three calls.

The 64 and 128 byte results sit on either side of the fastbin limit from the source, which is consistent with the fastbins being what keeps the small nodes off the lock. The runs do not measure a threshold. They measure those two sizes.

To test that directly, glibc lets you change its allocator settings for a single run through `GLIBC_TUNABLES`. `glibc.malloc.mxfast=0` turns the fastbins off, and `glibc.malloc.tcache_count=0` turns off the per-thread cache:

```bash
GLIBC_TUNABLES=glibc.malloc.mxfast=0 strace -f -c -e trace=futex ./futex malloc 64
GLIBC_TUNABLES=glibc.malloc.tcache_count=0 strace -f -c -e trace=futex ./futex malloc 64
GLIBC_TUNABLES=glibc.malloc.mxfast=0:glibc.malloc.tcache_count=0 strace -f -c -e trace=futex ./futex malloc 64
GLIBC_TUNABLES=glibc.malloc.mxfast=0:glibc.malloc.tcache_count=0 strace -f -c -e trace=futex ./futex pool 64
```

```
glibc.malloc.mxfast=0:                                  20742 calls   17759 calls   23928 calls
glibc.malloc.tcache_count=0:                            2 calls       2 calls       3 calls
glibc.malloc.mxfast=0:glibc.malloc.tcache_count=0:      20049 calls   30706 calls   26188 calls
both off, pool 64:                                      5 calls
```

With the fastbins off, the 64-byte nodes wait just like the larger ones. Turning off only the tcache changes nothing, which matches the source: the consumer's frees go to the fastbins anyway once its tcache is full, and the producer's tcache never held anything. With both off, the pool run still makes only 5 calls, because it never calls the allocator after startup.

## Taking Allocation Off the Hot Path

The fix is to stop calling the allocator while the queue is running:

```cpp
// producer thread
queue.push(new Node(val));        // queue is lock-free, but this new calls malloc

// consumer thread
Node* n = queue.pop();
delete n;                         // free from another thread: bigger blocks take the arena's lock

// fix: nodes are allocated once at startup and recycled through a second queue

// producer thread
Node* n = free_nodes.pop();       // no allocator call
queue.push(new (n) Node(val));    // construct in place

// consumer thread
Node* n = queue.pop();
n->~Node();
free_nodes.push(n);               // hand the node back, no free
```

The nodes are raw storage until placement new builds a `Node` in one, and the destructor runs explicitly before the node goes back. That is the same split between memory and object lifetime covered in the <a href="{{ site.baseurl }}/blog/memory/allocators/" target="_blank" rel="noopener noreferrer">allocators post</a>. The pool is the fixed-size chunk allocator from the <a href="{{ site.baseurl }}/blog/memory/block-allocators/" target="_blank" rel="noopener noreferrer">block allocators post</a>, with the free list replaced by a second queue.

The second queue is also a single-producer single-consumer queue, with the roles reversed. The consumer is its producer and the producer is its consumer. Each end of each queue has exactly one thread, so no compare-and-swap loop sits on a shared head and the ABA hazard does not come up in this design. A pool that many threads pop from through a shared compare-and-swap free list does bring it back, as the block allocators post describes.

The price is sizing. The pool has to hold the most nodes that can be in flight, which here is the queue's capacity plus one node held by each thread. If the pool runs dry there is no lock-free fallback. Falling back to `new` puts the hidden lock back, and blocking on a lock is the thing the design avoids. Running out is a sizing bug, not a condition to handle at runtime. In `pool` mode, a producer that finds the node queue empty spins, which does not happen when the pool is sized this way.

## What Else Changes the Picture

Replacing the allocator is the other option. tcmalloc gives each thread, or each CPU, a cache that needs no lock, and the design document says the central free lists and the transfer cache behind it are each protected by a mutex. So it moves most allocations off the lock without removing the lock. Nodes that cross threads, as they do in a producer and consumer pair, travel through those shared structures. That makes it a way to reduce contention, not a lock-free allocator. It was not tested here, and neither was jemalloc.

Memory reclamation is a separate problem that sits next to this one. In a queue with several consumers, a node that one consumer has popped might still be read by another consumer that loaded the pointer a moment earlier. Freeing it, or returning it to a pool for reuse, is unsafe until no thread can still be reading it. Hazard pointers and epoch-based reclamation exist to answer that question. The single-consumer queue here does not have it, because only one thread ever reads a popped node.

Pool chunks also share cache lines when they are smaller than a line. On x86-64 a line is 64 bytes. Nodes that sit next to each other and are written by different threads cause invalidations between cores, the false sharing covered in earlier posts. Aligning chunks to a line avoids it for nodes with writers on different threads. This was not measured here.

## Quick Reference

**Coming from other languages**

Environments where objects live on a managed heap handle allocation inside the runtime, and the cost of a collection or a shared allocation lock shows up as pauses rather than as something the program sizes up front. Where the program owns its allocations, a concurrent structure has to account for the allocator as one of its own components. A structure is non-blocking only if every shared resource it touches is, and the allocator is the shared resource that is easiest to overlook.

**The 90% mental model**

Lock-free describes the queue, not the allocator under it. In glibc, `malloc` takes the thread's arena mutex whenever the per-thread cache misses, and `free` goes to the arena the block came from, not the arena of the thread calling it. Small blocks are pushed onto a fastbin with an atomic operation. Larger ones take the arena mutex, so a producer that allocates and a consumer that frees contend for the same lock, and `futex` calls count how often that contention puts a thread to sleep. Allocate everything the queue can hold at startup and recycle nodes through a second queue, and neither thread touches the allocator again. The pool size becomes a hard design limit, and running out is a bug in the sizing.
