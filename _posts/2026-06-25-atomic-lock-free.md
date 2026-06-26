---
layout: post
title: "std::atomic Does Not Promise Lock-Free, and the API Around It"
date: 2026-06-25
domain: concurrency
permalink: /blog/concurrency/atomic-lock-free/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/concurrency/atomic-lock-free"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7475826992089571329-p9Xe"
---

`std::atomic<T>` only guarantees atomicity. Whether the implementation is lock-free underneath is left up to the platform and the size of the type. The standard does not promise it, and assuming it without checking is a real way to end up with a hidden mutex sitting inside something that looks like a simple atomic variable.

## What Lock-Free Actually Depends On

The reason comes down to hardware. A CPU can atomically touch a fixed number of bytes in one instruction, typically up to 8 bytes on x86_64, sometimes 16 bytes with specific instructions if the CPU and compiler both support them. A type that fits inside that width can be stored or loaded atomically with a single instruction, no lock involved anywhere. A type wider than what the CPU can move in one instruction has no such instruction to use. The standard library implementation has to fall back to something else under the hood, typically an internal mutex, to fake atomicity for something the hardware has no native primitive for.

This is why most platforms make `atomic<integral-type>` and `atomic<T*>` lock-free in practice. Integers and pointers are small enough to fit inside the widths the hardware supports. But that is a platform choice, not a language guarantee. Wrap a large struct in `std::atomic` and there is a real chance the implementation silently falls back to a lock.

```cpp
struct Small { int x; };          // 4 bytes, fits in one instruction
struct Big   { int data[8]; };    // 32 bytes, no single instruction covers it
```

Only three types in the standard come with a hard, portable guarantee of lock-free behavior regardless of platform: `atomic_flag`, `atomic_signed_lock_free`, and `atomic_unsigned_lock_free`. Everything else, including `atomic<int>` on a hypothetical exotic platform, has to be checked rather than assumed.

```cpp
// is_always_lock_free is static, it belongs to the type, not the object
std::atomic<Small>::is_always_lock_free   // correct
some_atomic_small.is_always_lock_free     // wrong, do not call it this way
```

`is_always_lock_free` is a `static constexpr` member. It belongs to the type itself, not to any particular instance, since whether a type can be made lock-free is a property of its size and the target platform, not something that varies between two objects of the same type.

The demo here checks exactly that, against a 4 byte struct that fits inside one instruction, a 32 byte struct that does not, and the three types with a hard guarantee:

```
atomic<Small>::is_always_lock_free = true
atomic<Big>::is_always_lock_free = false
atomic_flag is always lock-free by the standard, no check needed
atomic_signed_lock_free::is_always_lock_free = true
atomic_unsigned_lock_free::is_always_lock_free = true
```

## Watching the Fallback Happen in Generated Code

The `is_always_lock_free` check tells you the answer, but it does not show you why. `lock-free-fallback.cpp` is not meant to be run. It exists to be compiled to assembly and inspected with `objdump`, comparing the store instructions generated for atomics of increasing size: 4, 8, 16, and 32 bytes.

```cpp
struct FourBytes      { int data[1]; };  // 4 bytes
struct EightBytes     { int data[2]; };  // 8 bytes
struct SixteenBytes   { int data[4]; };  // 16 bytes
struct ThirtyTwoBytes { int data[8]; };  // 32 bytes

void store_4()  { a4.store({}, std::memory_order_relaxed); }
void store_8()  { a8.store({}, std::memory_order_relaxed); }
void store_16() { a16.store({}, std::memory_order_relaxed); }
void store_32() { a32.store({}, std::memory_order_relaxed); }
```

`store_4` and `store_8` should compile to a single inline instruction, no call instruction anywhere. `store_16` depends on whether the target CPU has 16 byte atomic support available and whether the compiler is permitted to use it, so this one can genuinely go either way depending on the build. `store_32` is past anything x86_64 can move in one instruction, so it should compile to a call into `libatomic` instead, a real function call replacing what would otherwise be a single `mov`.

```
```asm
0000000000000000 <_Z7store_4v>:
   0:   mov    rax,QWORD PTR [rip+0x0]
   7:   mov    DWORD PTR [rax],0x0                <-- single inline store, no call
   d:   xor    eax,eax
   f:   ret

0000000000000010 <_Z7store_8v>:
  10:   mov    rax,QWORD PTR [rip+0x0]
  17:   mov    QWORD PTR [rax],0x0               <-- single inline store, no call
  1e:   xor    eax,eax
  20:   ret

0000000000000030 <_Z8store_16v>:
  30:   mov    rdi,QWORD PTR [rip+0x0]
  37:   xor    ecx,ecx
  39:   xor    esi,esi
  3b:   xor    edx,edx
  3d:   jmp    42 <_Z8store_16v+0x12>            <-- jumps into a helper, not a plain inline mov like store_4/8

0000000000000050 <_Z8store_32v>:
  50:   push   rbp
  51:   pxor   xmm0,xmm0
  55:   xor    ecx,ecx
  57:   mov    edi,0x20
  5c:   mov    rbp,rsp
  5f:   sub    rsp,0x30
  63:   mov    rsi,QWORD PTR [rip+0x0]
  79:   lea    rdx,[rbp-0x30]
  7d:   movaps XMMWORD PTR [rbp-0x30],xmm0
  81:   movaps XMMWORD PTR [rbp-0x20],xmm0
  85:   call   8a <_Z8store_32v+0x3a>             <-- this is the libatomic call, the actual fallback
  99:   leave
  9a:   ret
```

This is the size-versus-instruction-width claim made visible directly in generated code, rather than just inferred from a true or false result.

Stack protector instructions and `nop` alignment padding between functions are trimmed from the output above, they are compiler safety and alignment artifacts unrelated to the atomic mechanism itself.

`store_4` and `store_8` compile to one plain `mov`, no call involved, since 8 bytes or fewer fits in a single x86_64 instruction. `store_16` and `store_32` both hand off to libatomic instead, `store_16` with a tail jump and `store_32` with a real call, since neither size fits in one instruction. See the Godbolt output below for the actual function names.

## A Separate Risk: Misalignment

Size is the main reason `is_always_lock_free` can come back false, but there is a second, narrower way to lose lock-free behavior even on a type that would normally qualify, and `is_always_lock_free` cannot see it at all, because that check is purely about the type, not about where a specific object actually lands in memory at runtime.

Ordinary struct layout cannot misalign a `std::atomic<T>`. The compiler enforces `alignof` for that type regardless of what surrounds it in a struct. The risk shows up specifically in code that works with raw memory directly: placement-newing an atomic into a buffer obtained from a custom allocator, or reinterpreting a pointer into memory that was not allocated with that type's alignment in mind. If the resulting address ends up misaligned, an atomic operation that would otherwise compile to a single locked instruction on x86 can straddle a cache line boundary at runtime and fall back to a full bus lock instead, which stalls every core on the memory bus, not just the one performing the access. This is undefined behavior under the standard, not a documented fallback path. It is a real concern specifically for code managing its own memory rather than relying on normal allocation, and it does not show up reliably enough on typical hardware to be worth forcing into a demo here. It is worth knowing about before reaching for a custom allocator with atomics, not something to expect to observe casually.

NUMA introduces a related but separate cost. On a multi-socket machine, an atomic operation touching memory that lives on a different socket's local memory has to cross the interconnect between sockets, which is slower than touching memory local to the core doing the access. This does not change whether an operation is lock-free, it changes how expensive that lock-free operation is once it has to travel across socket boundaries instead of staying within one socket's local memory.

## Compare and Swap: Weak vs Strong

`compare_exchange_weak` and `compare_exchange_strong` are the two faces of CAS, compare-and-swap, in the standard library. Both take the same shape: a reference to an `expected` value, a `desired` value, and an optional memory order, or separate memory orders for the success and failure cases. Both compare the atomic's current value against `expected` bitwise. If they match, the atomic is set to `desired` and the call returns `true`. If they do not match, the atomic's actual current value is loaded into `expected` and the call returns `false`, ready for the caller to retry with the now-updated `expected`.

The difference is what happens when the comparison should succeed. `compare_exchange_weak` is allowed to fail spuriously, meaning it can report failure even when `expected` genuinely matches the current value. `compare_exchange_strong` is not allowed to do this. On most platforms, strong is implemented internally as a loop around the same primitive weak uses, retrying automatically until a spurious failure is ruled out, which is exactly where its extra cost comes from.

```cpp
long long expected = counter.load(std::memory_order_relaxed);
while (!counter.compare_exchange_weak(
           expected, expected + 1,
           std::memory_order_relaxed, std::memory_order_relaxed)) {
    // expected is reloaded with the current value automatically on failure
}
```

The conventional guidance is to use strong for a single attempt or for simple types, and weak inside a retry loop, since a loop is already going to retry on failure regardless of whether that failure was real or spurious, so there is no reason to pay for strong's internal retry-on-spurious-failure on top of your own loop's retry. Weak is also generally preferred for types where the bitwise comparison itself is fragile, non-POD types, floating point values where NaN never compares equal to itself, or structs containing padding bytes that may not participate in the comparison consistently, since a spurious failure there is just one more retry, not a correctness problem.

That conventional guidance is worth testing against real numbers, not just repeating. This demo runs the same CAS-loop increment, once written around `compare_exchange_weak` and once around `compare_exchange_strong`, across 4 threads each doing 2 million increments on a shared counter under real contention:

```cpp
void increment_weak() {
    for (long long i = 0; i < kIncrementsPerThread; ++i) {
        long long expected = counter.load(std::memory_order_relaxed);
        while (!counter.compare_exchange_weak(
                   expected, expected + 1,
                   std::memory_order_relaxed, std::memory_order_relaxed)) {
            attempt_count.fetch_add(1, std::memory_order_relaxed);
        }
        attempt_count.fetch_add(1, std::memory_order_relaxed);
    }
}
```

The strong version is identical except for the call itself. Both record total CAS attempts and wall clock time.

```
weak:   267 ms, counter=8000000 (expected 8000000), total CAS attempts=10114875
strong: 251 ms, counter=8000000 (expected 8000000), total CAS attempts=9543962
```

On this machine, strong won on both numbers, fewer total attempts and less wall clock time, the opposite of what the conventional "use weak in loops" guidance would predict. Both versions land on the correct final counter value, so correctness is identical either way, the difference is purely in cost. The likely explanation is that this particular CPU and glibc combination implements `compare_exchange_strong` efficiently enough that its internal retry-on-spurious-failure adds negligible overhead, while still avoiding whatever spurious failures actually occurred in the weak version under this contention pattern, 10.1 million attempts to land 8 million successful increments versus 9.5 million for strong to land the same 8 million. That gap is real spurious failures showing up as wasted attempts, and on this run, weak's theoretical advantage in a tight loop did not outweigh the cost of those extra spurious retries.

This is the actual lesson, more useful than either answer in isolation: the weak-in-loops guidance is a reasonable default to start from, but it is platform and contention dependent, not a fixed law. If CAS performance matters in a hot path, measure it on the actual target hardware rather than assuming which one wins.

## atomic_ref: An Atomic View Without an Atomic Object

`std::atomic_ref<T>` lets existing, ordinary memory be treated as atomic without that memory having been declared as `std::atomic<T>` in the first place. It is a reference-like wrapper around an object's address, and every operation on it, store, load, exchange, the CAS pair, wait, and notify, behaves identically to the equivalent `std::atomic<T>` operation.

```cpp
int plain_value = 0;
std::atomic_ref<int> ref(plain_value);
ref.store(42, std::memory_order_release);
// any other atomic_ref constructed over the same plain_value
// behaves as the same atomic variable, not a separate one
```

The constraint worth knowing is about overlap. Each byte of storage may belong to at most one active `atomic_ref` at a time. Two `atomic_ref` instances over genuinely separate objects, even two different fields of the same class, are fine. But you cannot have one `atomic_ref` over an entire struct and a second `atomic_ref` over one field inside that same struct simultaneously, since that field's bytes would belong to two active atomic_ref instances at once. All `atomic_ref` instances that do legitimately point at the same object behave as one shared atomic variable for the purposes of synchronization and memory ordering between them, which is the entire point: it lets code add atomic access on top of memory that something else already owns and manages, without forcing that memory's declared type to be `std::atomic<T>` everywhere it is used. `atomic_ref` is copy constructible, and `.address()` returns a pointer to the object being referenced.

## atomic_flag: The One Type Without Store or Load

`atomic_flag` is the original, minimal atomic type, predating the more general `std::atomic<T>` template, and it remains the one type with an unconditional lock-free guarantee from the standard regardless of platform. It is deliberately narrow. It has no `store`, no `load`, and is not assignable. The entire interface is `clear`, `test_and_set`, `test`, plus `wait` and `notify_one`/`notify_all`.

```cpp
std::atomic_flag flag;

// spinlock built directly on atomic_flag
while (flag.test_and_set(std::memory_order_acquire)) {
    // spin until this thread is the one that flips it from false to true
}
// critical section
flag.clear(std::memory_order_release);
```

`test_and_set` sets the flag to `true` and returns whatever value it held immediately before that call. `clear` resets it back to `false`. `test` reads the current value without modifying it. This narrow interface is enough to build a spinlock directly, which is the flag's most common real use: the thread that calls `test_and_set` and gets back `false` is the one that just acquired the lock, since it was the one that flipped it from false to true. Every other thread spinning on the same call keeps getting back `true` until the lock is released.

## wait and notify: Blocking Instead of Spinning

`wait`, `notify_one`, and `notify_all` were added across `std::atomic`, `atomic_flag`, and `atomic_ref` to give atomics futex-like blocking behavior, without requiring a separate condition variable and mutex pair just to wait on a value change.

`wait(old_value, order)` atomically loads the current value and compares it against `old_value`. If they match, the calling thread blocks. If the thread is woken, whether by a real `notify_one`/`notify_all` call or by a spurious OS-level wakeup, it re-checks the value against `old_value` and goes back to blocking if nothing has actually changed. It is only guaranteed to return once the value has genuinely changed, never on a spurious wakeup alone. `notify_one` wakes at least one waiting thread. `notify_all` wakes every thread currently waiting on that atomic.

```cpp
std::thread producer([&]() {
    ready.store(1, std::memory_order_release);
    ready.notify_one();
});

ready.wait(0, std::memory_order_acquire);
// guaranteed to only return once ready no longer equals 0
```

The appeal over a plain spin loop is that a blocked thread waiting on `wait` is descheduled by the OS rather than burning a CPU core spinning on a load in a tight loop. That tradeoff is exactly what this demo measures, and the result is worth reading carefully:

```
spin:        avg handoff latency = 5474 ns
wait/notify: avg handoff latency = 10174 ns
```

Spinning is roughly twice as fast per handoff here. That is the expected outcome, not a sign that `wait`/`notify` is worse. This demo measures one thing only: how long it takes the waiting thread to notice the value changed. A spin loop has no OS scheduler in the path at all, so it notices a change within nanoseconds of it happening, at the cost of holding a CPU core at full usage for the entire wait, however long that turns out to be. `wait`/`notify` routes through the OS scheduler to park and wake the thread, which adds real, measurable latency to every handoff, visible directly in the roughly 4700 nanosecond gap between the two numbers above. What this demo does not measure is the other side of that tradeoff: CPU usage while waiting. A spin loop expecting a wait of unknown or potentially long duration burns an entire core the whole time, useful for nothing else. A thread parked in `wait` uses effectively zero CPU while blocked. Spinning wins when the expected wait is extremely short and latency is what matters most. `wait`/`notify` wins when the wait could be long, or when burning a full core just to poll a flag is not something the system can afford, even though any individual handoff will be slower to notice.

## The ABA Problem

`wait` compares values bitwise, not by tracking identity or history. That creates a specific failure mode known as the ABA problem: a thread reads a value `A`, gets descheduled before it acts on that read, and by the time it runs again, the value has been changed to something else and then changed back to `A`. From the standpoint of a bitwise comparison, nothing happened. The value is `A` both times. But in between, state was added and removed, possibly memory was freed and reallocated, possibly a different object entirely now happens to occupy the same bit pattern.

The classic setting where this shows up is a lock-free structure built on top of pointers, a free-list or lock-free stack being the usual example. Thread one reads the head pointer, intending to pop it. Before it completes that pop, it gets descheduled. While it is paused, other threads pop that same node, push other nodes, and eventually push a different node that happens to land at the exact same address as the original, since the allocator reused the freed memory. Thread one resumes, compares the head pointer against the value it originally read, sees a match, and proceeds as though nothing happened in between. The structure underneath it has actually changed completely. The address matching does not mean the same logical node is still there.

This connects back to `wait` directly: `wait(old_value, order)` is affected by exactly this problem. If a value changes away from `old_value` and then back to `old_value` again while a thread is parked in `wait`, that thread is not guaranteed to wake up and notice, because as far as the bitwise comparison is concerned, the value never differed from `old_value` at the moment it gets checked. A thread parked on `wait` across an ABA cycle can remain blocked indefinitely, since nothing about the interface promises it will be woken for a change that bitwise-reverts before the next check happens.

The general fix for ABA in lock-free structures is to stop comparing only the value and start comparing a value paired with a version counter or generation tag that only ever increases, so that a value reverting to its old bit pattern does not also revert the tag attached to it. That fix is a structural decision in how the data itself is laid out, not something the wait/notify interface provides on its own.

Another solution is to augment the value with a version counter and update both atomically using a `Double Width CAS`, so that a sequence like `A → B → A` becomes `(A,1) → (B,2) → (A,3)`, allowing threads to detect that the value changed even though it returned to the same bit pattern. Architectures that provide load-linked/store-conditional (LL/SC) primitives offer a similar benefit, since the store-conditional fails if any intervening write occurred between the load-linked and store-conditional, regardless of whether the final value matches the original. In both cases, the key idea is that correctness depends on detecting intervening modifications rather than simply comparing the current value, since wait itself performs only a bitwise comparison and provides no built-in protection against ABA.

## Quick Reference

**Coming from other languages**

Most languages with an atomics library expose this same shape: a lock-free guarantee for small, hardware-native sizes, a fallback to an internal lock for anything wider, and a CAS primitive with some notion of a weaker, allowed-to-fail variant alongside a strict one. Futex-style blocking on a value change, the same idea behind wait and notify here, also exists under different names in most systems languages and runtimes that expose low-level concurrency primitives directly. The ABA problem is not specific to C++ either. Any lock-free structure built on bitwise pointer or value comparison across a contended environment, in any language, is exposed to it the same way.

**The 90% mental model**

Do not assume `std::atomic<T>` is lock-free just because it compiles. Check `is_always_lock_free` if the type is anything other than a small integer or a pointer. For CAS, default to strong unless you have measured weak winning in your specific hot path on your specific hardware, since the textbook advantage of weak in loops is not guaranteed and can lose outright, as it did here. For waiting on a value change, spin only when the wait is expected to be very short and burning a core is acceptable. Reach for wait/notify when the wait could be long or holding a core hostage is not affordable, accepting the added latency that comes with going through the OS scheduler.
