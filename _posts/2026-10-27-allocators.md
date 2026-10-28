---
layout: post
title: "reserve, resize, and the Allocator Underneath"
date: 2026-10-27
domain: memory
permalink: /blog/memory/allocators/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/allocators"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7520682024366534656-8pJy/"
---

Every container in the standard library asks an allocator for memory. The allocator is the object doing two jobs: handing out raw bytes on request and separately building objects in those bytes when the container asks. Keeping those two jobs separate is what makes `reserve` and `resize` behave differently, what lets `std::allocate_shared` collapse two heap allocations into one, and what makes a `std::pmr::vector` usable with a stack buffer without changing the container type at all.

## The Four-Operation Split

`std::allocator<T>` is the default allocator for every STL container. It maps directly onto four memory primitives, and each one does exactly one thing:

```cpp
std::allocator<MyObj> alloc;

// raw memory for 10 objects, no construction
MyObj* p = alloc.allocate(10);

// construct object at slot 3, in place
std::allocator_traits<std::allocator<MyObj>>::construct(alloc, p + 3, args...);

// destroy object at slot 3, no deallocation
std::allocator_traits<std::allocator<MyObj>>::destroy(alloc, p + 3);

// release the raw memory, no destruction
alloc.deallocate(p, 10);
```

`allocate(n)` calls `operator new` and returns raw storage. No object is alive. `deallocate(p, n)` calls `operator delete` and returns the bytes. No destructor runs. `construct` runs placement new at a specific address. `destroy` calls the destructor and stops there.

Each operation touches exactly one side of the memory-lifetime boundary. None of them cross it.

Since C++17, `construct` and `destroy` moved to `std::allocator_traits`. The allocator itself only needs to implement `allocate` and `deallocate`. The traits class provides default `construct` and `destroy` implementations that forward to placement new and the destructor directly. Containers go through `allocator_traits` rather than calling the allocator member functions directly, so a custom allocator that only implements the two required operations gets correct `construct` and `destroy` behavior without writing them.

## Why reserve and resize Behave Differently

`reserve(n)` asks for capacity without building anything. If the current capacity is already large enough, the call does nothing. If it is not, the vector calls `allocate` for a new block and moves its existing elements in. The `allocate` call happens. No `construct` call happens for the empty slots. The size stays unchanged.

`resize(n)` builds objects to fill the gap between the current size and `n`. It calls `construct` on each new slot using the element type's default constructor. The size moves to `n`.

A logging allocator makes the call sequence concrete:

```
reserve(100):
  allocate(100)
  size=0 capacity=100 constructs=0
resize(100):
  size=100 capacity=100 constructs=100
```

`reserve(100)` goes to the allocator once for the raw block. The size stays 0 because nothing has been built in those bytes yet. `resize(100)` finds the capacity sufficient, skips `allocate`, and calls `construct` 100 times. Size becomes 100.

## What Happens Inside a Reallocation

When a vector grows past its capacity, the sequence is:

1. `allocate` a new buffer large enough for the expanded capacity
2. `construct` each element in the new buffer by move-constructing from the old one
3. `destroy` each element in the old buffer
4. `deallocate` the old buffer

Memory and object lifetime stay separate at every step. The old addresses are gone after step 4. This is why iterator invalidation on reallocation is not a bug; it is a direct consequence of the allocator model. The pointers the iterators held pointed into the old buffer, which no longer exists. `std::deque` avoids this by never moving existing blocks: it allocates a new chunk and leaves the existing ones in place, so iterators into old elements remain valid.

## Stateless Allocators and Propagation

`std::allocator` carries no state. Two instances of `std::allocator<T>` always compare equal, which means a container can hand its memory to another container and the new container can safely deallocate it, because both use the same underlying mechanism.

A custom stateful allocator breaks this assumption. Consider a pool allocator that owns its pool: two instances are not interchangeable, because memory allocated from one pool cannot be returned to another. The standard defines propagation traits on `std::allocator_traits` to tell containers what to do in these cases:

`propagate_on_container_copy_assignment`: if true, the container copies the allocator when the container is copy-assigned. If false, the existing allocator stays and the new elements are allocated using it.

`propagate_on_container_move_assignment`: if true, the container takes the allocator from the moved-from container. This is the case where ownership can transfer safely. If false, the container has to move-construct each element individually using its own allocator, because it cannot simply take the other container's buffer.

`propagate_on_container_swap`: if true, allocators are swapped along with contents. If false, the behavior is undefined when the allocators compare unequal.

`std::allocator` sets all three to false and always compares equal, so none of this matters for the default case. It matters as soon as the allocator owns something.

## std::allocate_shared and the Control Block

`std::shared_ptr<T>` needs a control block for the reference count, the weak count, and the deleter. `shared_ptr<int>(new int)` allocates the `int` first and then a separate control block: two heap allocations, two objects at potentially distant addresses.

`std::allocate_shared<int>(allocator, ...)` asks the allocator for one contiguous block large enough to hold both. The `int` is built into a slice of that block. One allocation, one object, one cache line.

```
allocate_shared<int>:     allocations=1 block=24 bytes
shared_ptr<int>(new int): allocations=2
```

The 24 bytes is the combined block on this implementation: two atomic reference counts plus the `int` plus alignment padding. The exact layout is implementation-defined; the single-allocation guarantee is not.

## PMR: Swapping the Source of Bytes

Polymorphic memory resources (`std::pmr`) decouple the allocator type from the source of memory at runtime. The interface is `std::pmr::memory_resource`, a class with two virtual functions: `do_allocate` and `do_deallocate`. Concrete implementations include:

`std::pmr::monotonic_buffer_resource`: starts with a buffer, hands out slices by bumping a pointer, and does not track individual deallocations. Deallocation is a no-op; all memory is released at once when the resource is destroyed. Zero bookkeeping overhead per allocation.

`std::pmr::unsynchronized_pool_resource`: maintains separate pools for different allocation sizes. Faster than the general heap for workloads with many same-size allocations, without the synchronization cost.

`std::pmr::synchronized_pool_resource`: same pool strategy, with a mutex. Usable from multiple threads.

`std::pmr::vector<T>` takes a `std::pmr::memory_resource*` at construction and wraps it in a `std::pmr::polymorphic_allocator<T>`. From the container's perspective, every allocation call goes through the same allocator interface. Whether the memory resource behind it is a stack buffer, a pool, or `new_delete_resource` is determined at construction, not at compile time. This is how PMR achieves runtime-selectable allocators without changing the container type.

The same 100-element push_back loop on both:

```
std::vector:      heap allocations=8
std::pmr::vector: heap allocations=0
```

A plain `std::vector` grows by doubling: 1, 2, 4, 8, 16, 32, 64, 128. Eight heap allocations for 100 elements. The `std::pmr::vector` backed by a 4096-byte stack buffer runs all eight of those growths from the buffer. Nothing reaches the heap.

Same container type, same push_back calls, same element count. Only the memory resource changed.

## Quick Reference

**Coming from other languages**

Environments with managed memory treat allocation and construction as a single opaque operation. There is no concept of raw storage that is not yet an object. The separation exposed here, where bytes can exist before construction and persist after destruction, is specific to manual-lifetime environments where the programmer or the library controls both steps. Allocators make that separation explicit and composable: any source of bytes can back a container as long as the bytes meet the alignment requirements.

**The 90% mental model**

An allocator splits memory into four operations: `allocate` returns raw bytes with no object in them; `construct` builds an object at a specific address inside those bytes; `destroy` calls the destructor without freeing memory; `deallocate` returns the raw bytes without calling any destructor. `reserve` calls `allocate` and stops; the size does not change because no object exists yet. `resize` calls `construct` for each new element; the size changes because objects now exist. When a vector reallocates, it allocates a new buffer, move-constructs into it, destroys the old elements, and deallocates the old buffer; iterators to old elements are invalid because those addresses no longer exist. `std::allocate_shared` uses the same split to put the control block and the managed object in one allocation. `std::pmr` uses it to let the bytes come from any source, including a stack buffer, without changing the container type.
