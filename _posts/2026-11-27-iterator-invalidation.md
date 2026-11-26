---
layout: post
title: "Iterator Invalidation: Why a Stale Iterator Can Look Fine"
date: 2026-11-27
domain: stl
permalink: /blog/stl/iterator-invalidation/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/stl/iterator-invalidation"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

Push elements onto the end of a `std::deque` and every iterator you held before is invalid. Keep using one anyway and, for a while, nothing happens. It returns correct values, step after step, until the address sanitizer stops the program in the middle of the loop. A `std::vector` can be wrong with no report at all: erase the first element and an iterator that pointed at the third now points at the fourth. This post follows both cases down into the implementation, to see why a stale iterator works until it does not, and which tools can see it.

## What a deque is Made of

A `std::deque` does not keep its elements in one array. libstdc++ stores them in fixed-size chunks and keeps an array of chunk pointers, which it calls the map. Elements stay in their chunk for their whole life. Only the map changes when the deque grows.

The chunk size is 512 bytes, so the number of elements per chunk depends on the element type. It is 512 divided by `sizeof(T)`, and 1 when `sizeof(T)` is 512 or more:

| Element type | `sizeof` | Elements per chunk |
|---|---|---|
| `char` | 1 | 512 |
| `int` | 4 | 128 |
| `double` | 8 | 64 |
| `std::string` | 32 | 16 |
| a 512-byte struct | 512 | 1 |

`deque.cpp` builds a `deque<int>` and prints where each new chunk starts. With `sizeof(int)` at 4 the boundaries fall every 128 elements:

```text
sizeof(int) = 4
new chunk starts at element 128
new chunk starts at element 256
new chunk starts at element 384
new chunk starts at element 512
new chunk starts at element 640
new chunk starts at element 768
new chunk starts at element 896
```

An iterator has to be able to cross from one chunk to the next, so it carries four pointers: `_M_cur`, the element it is on, `_M_first` and `_M_last`, the bounds of its chunk, and `_M_node`, the slot in the map that holds its chunk. That makes a `deque<int>::iterator` 32 bytes, against the 8 bytes of a vector iterator. The last pointer is the one that matters here, because it points into the map.

## What push_back Invalidates

The standard is specific about insertion at the ends of a deque: it invalidates all the iterators to the deque, but has no effect on the validity of references to its elements. A reference stays valid and an iterator to the same element does not.

```cpp
std::deque<int> d(4, 1);
int& ref = d.front();
auto it  = d.begin();
for (int i = 0; i < 100000; ++i)
    d.push_back(i);

int a = ref;                            // fine: the chunk holding the element never moved
int b = *it;                            // not allowed: the iterator is invalid, even if it appears to work
```

That asymmetry comes from the layout. The chunks do not move, so a reference to an element inside one is safe. The map does move. When the deque needs a chunk and the map has no free slot, it allocates a larger map, copies the chunk pointers over and frees the old one. The new size is the old size plus the larger of the old size and the number of slots needed, plus 2. A deque created with 4 ints starts with a map of 8 slots, and growing to 100000 elements walks it through several larger maps. The iterator `it` still holds a `_M_node` pointing into the first of them, which has been freed.

## Walking the Stale Iterator

The loop in `deque.cpp` takes the iterator before the pushes and then walks it:

```cpp
std::deque<int> d(4, 1);
auto it = d.begin();                    // iterator to the first element
for (int i = 0; i < 100000; ++i)
    d.push_back(i);                     // the map reallocates, the old one is freed: it is now stale

long sum = 0;
for (int k = 0; k < 50; ++k, ++it)      // 50 steps: stays inside the first chunk
    sum += *it;
// for (int k = 0; k < 200; ++k, ++it)  // 200 steps: passes element 128, ++it moves to the next chunk
//     sum += *it;                      // through the freed map
```

The 50-step version prints a correct sum:

```text
50 steps: sum 1039, expected 1039
```

The expected value is right because four elements are 1 and the pushes start at 0, so the first 50 elements sum to 4 plus 0 through 45, which is 1039.

Here is why 50 steps work. Incrementing an iterator is this:

```cpp
++_M_cur;
if (_M_cur == _M_last)
  {
    _M_set_node(_M_node + 1);           // reads *(_M_node + 1) from the map
    _M_cur = _M_first;
  }
```

Inside a chunk the increment only moves `_M_cur`, and the dereference reads the element through it. Neither touches the map. The chunk itself is still allocated and still holds the right values, so the stale iterator behaves. Only when `_M_cur` reaches `_M_last` does the increment follow `_M_node` back into the map to find the next chunk, and that map is the freed one. The first chunk covers elements 0 through 127, so the increment that steps off element 127 is the first to read the freed memory. Every step before it is correct.

The 200-step version crosses that boundary. Built with the address sanitizer, which adds run-time checks for reads and writes of freed or out-of-bounds memory, it is stopped:

```bash
g++ -std=c++20 -O2 -fsanitize=address deque.cpp -o deque_asan && ./deque_asan
```

```text
==34609==ERROR: AddressSanitizer: heap-use-after-free on address 0x6fd8055e0040 at pc 0x642c3bf7056f bp 0x7fffef112940 sp 0x7fffef112938
READ of size 8 at 0x6fd8055e0040 thread T0
    #0 0x642c3bf7056e in std::_Deque_iterator<int, int&, int*>::_M_set_node(int**) stl_deque.h:269
    #1 0x642c3bf7056e in std::_Deque_iterator<int, int&, int*>::operator++() stl_deque.h:198
    #2 0x642c3bf7056e in main deque.cpp:37
```

The paths in the report are shortened here. The report reads like the code above. The frame at the top is `_M_set_node`, called from `operator++`, called from the loop on line 37. The read is 8 bytes wide, the size of one chunk pointer. The rest of the report names the allocation:

```text
0x6fd8055e0040 is located 32 bytes inside of 64-byte region [0x6fd8055e0020,0x6fd8055e0060)
freed by thread T0 here:
    ... in std::deque<int, std::allocator<int> >::_M_reallocate_map(unsigned long, bool) deque.tcc:1146
    ... in std::deque<int, std::allocator<int> >::push_back(int const&) stl_deque.h:1614
    ... in main deque.cpp:29
previously allocated by thread T0 here:
    ... in std::_Deque_base<int, std::allocator<int> >::_M_initialize_map(unsigned long) stl_deque.h:648
    ... in std::deque<int, std::allocator<int> >::deque(unsigned long, int const&, std::allocator<int> const&) stl_deque.h:894
    ... in main deque.cpp:26
```

The 64-byte region is eight pointers, which is the initial map of 8 slots that the constructor allocated on line 26. It was freed by `_M_reallocate_map`, called from `push_back` on line 29. The offset of 32 bytes is slot 4. The constructor puts a single chunk at slot 3, the middle of the map, so the stale iterator's `_M_node` is slot 3 and `_M_node + 1` is slot 4. Every number in the report follows from the layout.

Without the sanitizer, a stale read of the freed map does not fail on its own. The freed block is still mapped and still holds its old pointers, so the increment finds a valid-looking chunk pointer and carries on. The old map had five of its slots filled when it was freed, one chunk each, so in this program a plain build reads the first 640 elements correctly and then crashes. What the program does after the free is up to the allocator, and the program is no more correct for having survived.

## When the Index is Not Freed

The map is not always reallocated. When it has plenty of room, `_M_reallocate_map` keeps the same array and shifts the chunk pointers within it to recentre them. The condition is that the map size is more than twice the number of nodes needed after the insertion. That happens to a deque used as a queue, with `push_back` at one end and `pop_front` at the other, because the popped chunks free up space at the front of the map while the pushes keep walking toward the back:

```cpp
std::deque<int> d;
for (int i = 0; i < 5000; ++i) d.push_back(i);
for (int i = 0; i < 4000; ++i) d.pop_front();     // front chunks are freed, the map keeps its size

auto it = d.begin() + 500;                        // element 4500
for (int i = 5000; i < 9000; ++i) d.push_back(i); // the map shifts its pointers in place
// walking it: correct for 108 steps, then it reads 8320 where the element is 4608
```

Nothing is freed this time, so there is no use after free to report. The sanitizer build stays silent. The stale `_M_node` still points at a valid slot of the same map, but the slot now holds the pointer to a different chunk, because the pointers moved. The iterator finishes the rest of its own chunk, which is the 108 steps, then follows `_M_node + 1` to the wrong chunk and reads values from somewhere else in the deque. This is the worst of the three outcomes, since it neither crashes nor reports.

## The Vector Cases

A vector has two ways to invalidate an iterator and they behave differently.

**Reallocation.** When `push_back` or `insert` outgrows the capacity, the vector allocates a new buffer, moves the elements and frees the old one. The standard says reallocation invalidates all references, pointers and iterators, and this one is loud. The old buffer is freed, so the first dereference of a stale iterator reads freed memory and the sanitizer reports it:

```cpp
std::vector<int> v{1, 2, 3, 4};
auto it = v.begin();
v.push_back(5);                         // capacity was 4: new buffer, old one freed
int x = *it;                            // heap-use-after-free on the first use
```

**Shifting elements.** `erase` and `insert` without reallocation move elements within the same buffer. The standard says `erase` invalidates iterators and references at or after the point of the erase:

```cpp
std::vector<int> v{1, 2, 3, 4};
auto p = v.begin() + 2;                 // points at 3
v.erase(v.begin());                     // 2, 3, 4 shift left by one
int x = *p;                             // 4: no crash, no report, wrong element
```

Compiled and run, this prints `x = 4`. The iterator is still a pointer to a live address inside a live buffer, and that address now holds the next element. Neither the address sanitizer nor `-D_GLIBCXX_ASSERTIONS` has anything to report, since no memory rule was broken. The program does the wrong thing quietly, and a test that only checks that nothing crashed will pass.

## What the Checked Mode Does

libstdc++ has a checked mode that catches these cases by tracking iterators instead of memory. With `-D_GLIBCXX_DEBUG`, `std::vector` and `std::deque` become the versions in the `std::__debug` namespace. Each container keeps a list of the iterators attached to it, and every operation that invalidates iterators walks the list and marks the affected ones singular. A `push_back` on the debug deque marks all of them, and `erase` on the debug vector marks the ones from the erase position on. Using a singular iterator is reported at once:

```text
Error: attempt to dereference a singular iterator.

Objects involved in the operation:
    iterator "this" @ 0x7ffcc768e0e0 {
```

Built this way, the 50-step and the 200-step deque loops give the same report, and so does the vector `erase`:

```bash
g++ -std=c++20 -O2 -D_GLIBCXX_DEBUG deque.cpp -o deque_debug && ./deque_debug
```

The check does not depend on how far the iterator walks or on what the freed memory contains, because it is made at the first use. It also covers the shifted-map case above, where the sanitizer saw nothing. There it is reported at the first copy of the stale iterator, as `attempt to copy-construct an iterator from a singular iterator`.

The cost is that the containers are bigger and slower. A `std::vector<int>` grows from 24 to 56 bytes and its iterator from 8 to 40 bytes on x86-64. The layouts are different, so the whole program and every library that passes these containers across an interface has to be built with the flag. It is a mode for test builds.

## Which Tool Sees Which Case

| Case | Address sanitizer | `_GLIBCXX_DEBUG` |
|---|---|---|
| deque, stale iterator stepping inside its first chunk | no report | reported at the first use |
| deque, stale iterator crossing a chunk boundary after the map was freed | reported at the boundary | reported at the first use |
| deque, map shifted in place (queue-like use) | no report, wrong values | reported |
| vector, `push_back` reallocated | reported at the first use | reported at the first use |
| vector, `erase` shifted the elements | no report | reported |

The sanitizer reports a memory error, so it can only see an invalidation that turns into one, and only at the moment it does. Whether a test trips it depends on how far the test walks. Checked mode reports the invalidation itself. A small input that passes the sanitizer proves little, and a production-sized input can then fail somewhere that looks unrelated.

## Quick Reference

**What the standard says is invalidated**

| Container | Insertion | Erase |
|---|---|---|
| `vector` | all, if it reallocates; otherwise from the insertion point on | from the erase point on |
| `deque` | in the middle: all iterators and references. At either end: all iterators, no references | middle: all. First or last element: only the erased element, and `end()` for the last |
| `list`, `forward_list` | none | only the erased elements |
| `map`, `set` and the other ordered containers | none | only the erased elements |
| `unordered_map`, `unordered_set` and the others | may invalidate all iterators if it rehashes, references stay valid | only the erased elements |

**Coming from other languages**

Many languages keep a version counter in the container and compare it on each step of an iterator, so a change during iteration raises an error on the next step. That check is usually best-effort. Others rule it out before the program runs, because their ownership rules do not allow a container to be modified while an iterator refers into it. C++ does neither by default. Using an invalid iterator is undefined behavior with no required diagnostic, and the outcome is whatever the layout in memory produces.

**The 90% mental model**

An iterator is a position described in terms of the container's current storage, and any operation that changes that storage can make it stale. For a vector the storage is one buffer, so reallocation is a crash and shifting elements is a wrong value. For a deque the iterator also points into the map, so a stale iterator works until it crosses a chunk boundary, and what happens there depends on whether the map was freed or shifted. A reference to a deque element survives `push_back`, and an iterator does not. After any insertion or erase, take a fresh iterator from the container unless the table above says yours is safe. Test with an address sanitizer build and with `-D_GLIBCXX_DEBUG`, since each sees cases the other cannot.
