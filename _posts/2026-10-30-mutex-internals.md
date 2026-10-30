---
layout: post
title: "A Mutex Is a Number That Is 0, 1 or 2"
date: 2026-10-30
domain: concurrency
permalink: /blog/concurrency/mutex-internals/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/concurrency/mutex-internals"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

On Linux with glibc, the state of a `std::mutex` is one 4-byte integer that is 0, 1 or 2. The difference between 1 and 2 decides whether unlocking has to call the kernel. The mutex does not keep a list of waiting threads. It keeps one fact, whether anyone is waiting, and lets the kernel remember who.

## The Lock Word

`std::mutex` in libstdc++ holds a `pthread_mutex_t`, and `lock()` calls `pthread_mutex_lock` on it. `native_handle()` returns a pointer to that `pthread_mutex_t`. The type is a 40-byte struct on 64-bit Linux, and the lock state is its first field:

```cpp
struct __pthread_mutex_s {
    int          __lock;     // the 0, 1, 2 lock word
    unsigned int __count;    // recursion depth, recursive mutexes only
    int          __owner;    // thread id of the holder
    unsigned int __nusers;
    int          __kind;     // normal, recursive, error-checking, adaptive...
    int          __spins;
    __pthread_list_t __list;
};
```

The lock word has three values:

- 0: free.
- 1: locked, nobody waiting.
- 2: locked, at least one thread waiting.

Everything else in the struct is bookkeeping for the other mutex types, and a normal mutex mostly leaves it alone. The word itself is the part the futex system call works on.

## Locking

A thread that wants the lock tries one atomic compare-and-swap from 0 to 1 with acquire ordering. If it works, the thread owns the lock and the kernel never hears about it.

If it fails, the lock is held. The thread then atomically swaps the word to 2, which announces that someone is waiting. If the swap returns 0, the lock was released in the meantime and the thread now owns it. If it returns anything else, the thread calls `futex` to sleep, and loops back to the swap when it wakes:

```cpp
// simplified from glibc's __lll_lock_wait
while (atomic_exchange_acquire(&lock, 2) != 0)
    futex_wait(&lock, /*expected*/ 2);   // sleep only if the word is still 2
```

The swap to 2 is what makes the unlock side work. The owner has no other way to learn that a thread is asleep, because the sleeper is inside the kernel.

## Why the Value Check Prevents a Lost Wake-Up

`futex_wait` takes an expected value, and the kernel puts the thread to sleep only if the word still holds it. The check and the sleep are one atomic step from the caller's point of view.

Without the check, this sequence loses a wake-up. A thread sets the word to 2. The owner unlocks, sees the 2, and calls wake, but nobody is asleep yet, so the wake does nothing. The thread then goes to sleep and nobody is left to wake it.

With the check, the same sequence ends differently. The owner's unlock set the word to 0 before the thread reached the kernel, so the thread's wait finds 0 where it expected 2 and returns immediately. The thread loops, swaps the word to 2, gets back 0, and owns the lock.

Waits can also return spuriously. The swap in the loop is what makes that safe, since the thread only leaves the loop when the swap returns 0.

## Unlocking

Unlocking is one atomic swap of the word to 0 with release ordering, followed by a look at the old value. If the old value was 1, nobody was waiting and the kernel is never involved. If it was 2, the thread calls `futex` to wake one sleeper:

```cpp
// simplified from glibc's __lll_unlock
int old = atomic_exchange_release(&lock, 0);
if (old > 1)
    futex_wake(&lock, /*count*/ 1);
```

The woken thread does not get the lock back with the word at 1. It runs the swap to 2, so it holds the lock with the word at 2, because it cannot know whether other threads are still waiting. Its own unlock sees 2 and calls `futex` wake again, and that call finds nobody and returns 0. The cost of this is one extra system call after a contended hand-off. Keeping the word at 2 when unsure is what stops a sleeper from being stranded.

The acquire on the locking side and the release on the unlocking side are what the standard asks for: an unlock synchronizes with a later lock of the same mutex, so everything the first owner wrote is visible to the next one.

## The Single-Thread Shortcut

The description above, one atomic instruction to lock, applies once a process has more than one thread. In glibc 2.39, a normal private mutex in a process with a single thread skips the atomics. If the lock word is 0 it is set to 1 with a plain store, and an unlock sets it back to 0 with a plain store. The check is on both paths and is restricted to private mutexes, because a mutex in shared memory can be taken by another process even when this one has one thread.

This is from reading the source, and the demonstrations below do not isolate it. It is why an uncontended lock and unlock in a single-threaded program costs very little, and the first thread created changes which path every later call takes.

## What the Code Shows

`state.cpp` prints the lock word at each step of a contended lock. The main thread locks, a second thread finds the lock held and sleeps, and the main thread reads the word, unlocks, and joins. The sleeper records the word right after it gets the lock. It runs once on a `pthread_mutex_t` and once on a `std::mutex` through `native_handle()`.

```bash
g++ -std=c++20 -O2 -pthread state.cpp -o state
./state
```

```
sizeof(pthread_mutex_t) = 40, sizeof(__data.__lock) = 4
lock word at 0x7ffeda056250

pthread_mutex_t:
0
1
2
0
2  (value the woken thread saw while it held the lock)

std::mutex:      sizeof = 40, same size as pthread_mutex_t: 1
0
1
2
0
```

The word goes 0, 1, 2, 0 as described. The `sleep(1)` in the program gives the second thread time to reach `futex` before the main thread reads the word, so the 2 depends on that timing and not on any ordering guarantee. `std::mutex` has the same size and goes through the same four values, which is what a thin wrapper looks like. The last line of the first block is the 2 the woken thread saw while it held the lock, matching the explanation above.

`strace` shows the system calls behind those values. `-f` follows the threads the program creates and `-e trace=futex` limits the output to `futex`:

```bash
strace -f -e trace=futex ./state
```

```
futex(0x6ffc508b96bc, FUTEX_WAKE_PRIVATE, 2147483647) = 0
[pid 17067] futex(0x7ffd98f46550, FUTEX_WAIT_PRIVATE, 2, NULL <unfinished ...>
[pid 17066] futex(0x7ffd98f46550, FUTEX_WAKE_PRIVATE, 1) = 1
[pid 17067] <... futex resumed>)        = 0
[pid 17066] futex(0x6ffc501ff990, FUTEX_WAIT_BITSET|FUTEX_CLOCK_REALTIME, 17067, NULL, FUTEX_BITSET_MATCH_ANY <unfinished ...>
[pid 17067] futex(0x7ffd98f46550, FUTEX_WAKE_PRIVATE, 1) = 0
[pid 17066] <... futex resumed>)        = 0
```

The address in the `FUTEX_WAIT_PRIVATE` call, 0x7ffd98f46550, is the lock word the program printed in that run. The sleeper waits with expected value 2. The main thread's unlock calls `FUTEX_WAKE_PRIVATE` for one waiter and gets back 1, the one thread it woke. The woken thread's own unlock then calls `FUTEX_WAKE_PRIVATE` as well and gets back 0. The `PRIVATE` variants are used because the mutex is shared only between threads of one process. The `FUTEX_WAIT_BITSET` on a different address is the main thread waiting in `join`, and the first line is libc starting up. The same sequence repeats for the `std::mutex` at its own address.

`uncontended.cpp` locks and unlocks a `std::mutex` 1,000,000 times from one thread:

```bash
g++ -std=c++20 -O2 -pthread uncontended.cpp -o uncontended
./uncontended
strace -f -e trace=futex ./uncontended
```

```
locked and unlocked 1000000 times
futex(0x7240d2cb96bc, FUTEX_WAKE_PRIVATE, 2147483647) = 0
locked and unlocked 1000000 times
+++ exited with 0 +++
```

A million lock and unlock pairs, and one `futex` call in the whole run. That call is the same libc startup wake as in the first trace, before the loop starts. The loop itself never reaches the kernel. This is the case where every lock finds 0 and every unlock finds 1.

`futex_value.cpp` calls the `futex` system call directly to show the check from earlier:

```bash
g++ -std=c++20 -O2 futex_value.cpp -o futex_value
./futex_value
```

```
number is 1, expect 2: returned -1, errno Resource temporarily unavailable
number is 2, expect 2: returned -1, errno Connection timed out, slept about 100 ms
```

A wait that expects 2 on a number that is 1 returns at once with `EAGAIN`, shown as "Resource temporarily unavailable", and the thread never sleeps. In a mutex, the number that has changed is the 0 left by an unlock that happened before the thread reached the kernel. A wait that expects 2 on a number that is 2 sleeps, and here it gives up after the 100 ms timeout with `ETIMEDOUT`.

## Other Lock Types and the Same Word

The other mutex types in `<mutex>` are variations on this layout, and the unused fields of the struct are where they differ.

`std::recursive_mutex` uses the same word and the same futex path. The difference is in the other fields. On lock, if `__owner` already equals the calling thread's id, glibc increments `__count` and returns without touching the lock word. If it does not, the thread takes the word as usual and records itself as owner. The counter is an unsigned int, and when it would overflow glibc returns `EAGAIN`, which libstdc++ turns into a `std::system_error`.

`std::timed_mutex` also uses a `pthread_mutex_t`, with a timed version of the wait. Its size matches the plain mutex.

`try_lock` is the compare-and-swap from 0 to 1 and nothing more. In glibc it is a strong compare-and-swap, so it fails only when the lock is held. The standard allows `try_lock` to fail spuriously, which this implementation does not do, and portable code cannot rely on that.

`std::shared_mutex` is a different object. libstdc++ builds it on `pthread_rwlock_t`, which is 56 bytes, and the lock state there is more than a single 0, 1, 2 word because readers have to be counted. It was not tested here.

An ordinary `std::mutex` does not spin before sleeping. glibc's adaptive spinning applies only to mutexes created with the adaptive type, which `std::mutex` does not use.

## Futex and Spinlocks

The futex design avoids system calls when the lock is free, which is the case in the first trace above. When the lock is held, a contended lock costs system calls and a context switch for the waiter, and it keeps the waiter off the CPU while it waits. A spinlock avoids the system call and burns CPU while it waits. Which one is faster depends on how long the lock is held and how many threads compete, and no measurement here compares them. The <a href="{{ site.baseurl }}/blog/memory/allocator-contention/" target="_blank" rel="noopener noreferrer">allocator contention post</a> uses the same observation, that `futex` calls count how often threads actually wait, not how often they take the lock.

## Quick Reference

**Coming from other languages**

A lock that is cheap when free and expensive only when contended is a common design in systems that sit close to the operating system. The state lives in one machine word that user code updates atomically, and the kernel is asked for help only when a thread has to sleep. The word does not describe who is waiting, only that someone is. That keeps the free path to an instruction or two and moves the queue into the kernel.

**The 90% mental model**

A normal mutex is one 4-byte number: 0 free, 1 locked with nobody waiting, 2 locked with a waiter. Lock tries to change 0 to 1 and, on failure, sets 2 and sleeps in `futex`, which only sleeps if the number is still 2. Unlock sets 0 and calls `futex` to wake one thread only if the old value was 2. A thread that wakes holds the lock with the number at 2, so its own unlock makes one wake call that finds nobody. An uncontended lock and unlock never reach the kernel, and in a single-threaded process they skip the atomics too.
