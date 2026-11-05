---
layout: post
title: "The Singleton Guard and What constexpr Removes"
date: 2026-11-05
domain: compiler
permalink: /blog/compiler/singleton-guard/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/singleton-guard"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

A function-local `static` is thread-safe since C++11, and the compiler pays for that guarantee with a hidden guard variable. Every call to the function loads it, tests it and branches. Give the object a `constexpr` constructor and the compiler builds it at compile time instead, so the guard, the check and the lock all disappear. This post follows the guard from the disassembly down into the runtime library and then shows what `constexpr` and `constinit` change.

## The Guard That Compiler Adds

The Singleton pattern means one object for the whole program, reached through a function. In modern C++ that is a `static` variable inside the function, and the function returns a reference to it:

```cpp
struct Plain {
    int value;
    Plain() : value(69) {}              // same body, not constexpr
};

Plain& plain_instance() {
    static Plain c;                     // guard: load, test, branch on every call
    return c;                           // first call: __cxa_guard_acquire, build, release
}

struct Const {
    int value;
    constexpr Const() : value(69) {}    // same body, constexpr
};

Const& const_instance() {
    static Const c;                     // no guard: built at compile time
    return c;
}
```

The two constructors have the same body. The only difference is one keyword.

A function-local static is built the first time control passes through its declaration, so it needs a record of whether that has happened. Since C++11 the standard also says that if two threads reach the declaration at once, one builds the object and the other waits for it to finish. That record is the guard variable, and the code for the two cases is in the runtime library that ships with the compiler (the Itanium C++ ABI on Linux).

This is the usual fix for the Static Initialization Order Fiasco covered in the <a href="{{ site.baseurl }}/blog/language/before-main/#global-constructors-and-the-static-initialization-order-fiasco" target="_blank" rel="noopener noreferrer">before-main post</a>, because the object is built on first use and not before `main`. The guard is what that costs.

## Reading the Disassembly

`codegen.cpp` holds the two structs above and is never run. It is compiled to an object file and inspected with `objdump` and `nm`:

```bash
g++ -std=c++20 -O2 -c codegen.cpp -o codegen.o
objdump -dr -M intel --no-show-raw-insn --demangle codegen.o | awk '/<plain_instance\(\)>:/,/^$/'
objdump -dr -M intel --no-show-raw-insn --demangle codegen.o | awk '/<const_instance\(\)>:/,/^$/'
```

`-c` compiles to an object file without linking, since the file has no `main`. In `objdump`, `-d` disassembles, `-r` prints relocations so the names of the called functions show up, `-M intel` selects Intel syntax, `--no-show-raw-insn` hides the instruction bytes and `--demangle` turns symbol names back into C++. The `awk` keeps one function at a time.

```
0000000000000000 <plain_instance()>:
  0:   movzx  eax,BYTE PTR [rip+0x0]        # 7 <plain_instance()+0x7>
                       3: R_X86_64_PC32        .bss-0x4
  7:   test   al,al
  9:   je     18 <plain_instance()+0x18>
  b:   lea    rax,[rip+0x0]        # 12 <plain_instance()+0x12>
                       e: R_X86_64_PC32        .bss+0x4
 12:   ret
 13:   nop    DWORD PTR [rax+rax*1+0x0]
 18:   push   rbp
 19:   lea    rdi,[rip+0x0]        # 20 <plain_instance()+0x20>
                       1c: R_X86_64_PC32       .bss-0x4
 20:   mov    rbp,rsp
 23:   call   28 <plain_instance()+0x28>
                       24: R_X86_64_PLT32      __cxa_guard_acquire-0x4
 28:   test   eax,eax
 2a:   jne    38 <plain_instance()+0x38>
 2c:   lea    rax,[rip+0x0]        # 33 <plain_instance()+0x33>
                       2f: R_X86_64_PC32       .bss+0x4
 33:   pop    rbp
 34:   ret
 35:   nop    DWORD PTR [rax]
 38:   lea    rdi,[rip+0x0]        # 3f <plain_instance()+0x3f>
                       3b: R_X86_64_PC32       .bss-0x4
 3f:   mov    DWORD PTR [rip+0x0],0x45        # 49 <plain_instance()+0x49>
                       41: R_X86_64_PC32       .bss
 49:   call   4e <plain_instance()+0x4e>
                       4a: R_X86_64_PLT32      __cxa_guard_release-0x4
 4e:   lea    rax,[rip+0x0]        # 55 <plain_instance()+0x55>
                       51: R_X86_64_PC32       .bss+0x4
 55:   pop    rbp
 56:   ret
 57:   nop    WORD PTR [rax+rax*1+0x0]

0000000000000060 <const_instance()>:
 60:   lea    rax,[rip+0x0]        # 67 <const_instance()+0x7>
                       63: R_X86_64_PC32       .data-0x4
 67:   ret
```

`plain_instance` starts by loading one byte, the guard flag, from `.bss` (`movzx`), testing it (`test`) and jumping to the slow path if it is zero (`je`). Every call after the first falls through to the `lea` and `ret` at offsets `b` and `12`, which return the address of the object. The steady-state cost is that load, test and branch.

The slow path starts at offset `18`. It calls `__cxa_guard_acquire`, stores `0x45` (69) into the object, which is the constructor body inlined, and calls `__cxa_guard_release`. The `push rbp` and `mov rbp,rsp` on the slow path are frame pointer setup from this machine's default compiler flags and are not part of the guard.

`const_instance` is a `lea` and a `ret`. It loads no flag, tests nothing and calls nothing.

The object files show the same split in the symbols:

```bash
nm -C codegen.o
objdump -s -j .data codegen.o
```

`nm` lists the symbols with `-C` demangling them, and `b` marks `.bss` while `d` marks `.data`. `objdump -s -j .data` dumps the contents of the `.data` section.

```
                U __cxa_guard_acquire
                U __cxa_guard_release
0000000000000060 T const_instance()
0000000000000000 T plain_instance()
0000000000000000 b guard variable for plain_instance()::c
0000000000000000 d const_instance()::c
0000000000000008 b plain_instance()::c

codegen.o:     file format elf64-x86-64

Contents of section .data:
0000 45000000                             E...
```

The compiler generated a `guard variable` for `plain_instance()::c` and none for `const_instance()::c`. The plain object lives in `.bss`, which holds zeroes until the program writes to it at run time. The `constexpr` object lives in `.data` and already contains `45000000`, which is 69 as a 4-byte integer, stored in the file before the program starts. That is what "built at compile time" means here.

## What the Slow Path Does

The slow path is not a mutex. In libstdc++ on Linux, `__cxa_guard_acquire` and `__cxa_guard_release` work on the guard variable itself, using atomic operations and the `futex` system call. The source comment in `guard.cc` (read at the GCC 13.3.0 tag) lists the values the guard can hold:

- 0: no thread has started the initialization, or it was aborted.
- Initialized: the object has been built.
- Pending: one thread is building it and nobody is waiting.
- Pending with waiting: one thread is building it and at least one other thread is waiting.

The first thread to reach `__cxa_guard_acquire` changes the guard from 0 to pending with a compare-and-swap and returns 1, which tells the compiled code to run the constructor. A thread that finds the guard pending sets the waiting bit and sleeps in `futex` on the guard's address, with the guard's current value as the expected value. This is the same check described in the <a href="{{ site.baseurl }}/blog/concurrency/mutex-internals/" target="_blank" rel="noopener noreferrer">mutex internals post</a>: the kernel only puts the thread to sleep if the value has not changed.

`__cxa_guard_release` swaps the guard to the initialized value and, if the old value had the waiting bit set, wakes every sleeper with one `futex` wake. Each of them returns from `__cxa_guard_acquire` with 0, which tells the compiled code the object is ready.

If the constructor throws, the compiled code calls `__cxa_guard_abort`, which resets the guard to 0 and wakes the waiters. One of them then becomes the thread that tries again, which matches the standard: a failed initialization is retried the next time control reaches the declaration. If the constructor reaches its own declaration again while it is running, the standard calls that undefined behavior. In a process with one thread, libstdc++ skips the atomics and the futex calls and throws `recursive_init_error` in that case. With several threads, reading the source, the recursive caller finds the guard pending and waits for a build that it is itself blocking.

The check in the compiled function reads the guard with acquire ordering. On x86-64 a plain byte load already has that ordering, which is why the disassembly shows a single `movzx`. On AArch64, a Clang build of the same function emits `ldarb`, a load-acquire. This is what lets a thread that sees the guard set also see the fully built object.

## Measuring the Wait

`timing.cpp` has four threads call `instance()` at the same moment. Each thread waits on a flag so all four start together, then records its wall time, how long the call took, and its CPU time, how long the thread was running during it. The constructor spins for 300 ms. The same four threads then call an `instance()` with a `constexpr` constructor.

```bash
g++ -std=c++20 -O2 -pthread timing.cpp -o timing
./timing
```

`-pthread` is required for `std::thread` with GCC on Linux.

```
constructor that takes 300 ms (guarded):
 thread 0: wall  300.02 ms, cpu  299.99 ms
 thread 1: wall  300.36 ms, cpu    0.03 ms
 thread 2: wall  300.06 ms, cpu    0.03 ms
 thread 3: wall  300.42 ms, cpu    0.03 ms
constexpr constructor (no guard):
 thread 0: wall    0.00 ms, cpu    0.00 ms
 thread 1: wall    0.00 ms, cpu    0.00 ms
 thread 2: wall    0.00 ms, cpu    0.00 ms
 thread 3: wall    0.00 ms, cpu    0.00 ms
```

All four threads spent 300 ms inside the call. Thread 0 ran the constructor and used 299.99 ms of CPU doing it. The other three used 0.03 ms of CPU across their 300 ms, so they were asleep waiting for the guard, the sleep in `futex` described above. Which thread runs the constructor changes from run to run. With a `constexpr` constructor there is nothing to wait for and every call takes no measurable time.

This test uses a slow constructor on purpose. It shows what a waiting thread costs, not what the check costs once the object exists. After the first call the check is the load, test and branch from the disassembly, and it was not timed here.

## What constexpr and constinit Change

A `constexpr` constructor lets the compiler evaluate the initializer at compile time, so the variable is constant-initialized. The standard performs constant initialization before any dynamic initialization, so there is no moment when the object might not exist yet. That is why the guard has nothing left to guard: no flag, no check, no lock, and the bytes of the object are written into the executable's `.data` section.

This only works when the constructor can run at compile time. A constructor that reads a file or calls code the compiler cannot evaluate keeps the guard. A `constexpr` constructor in a type whose arguments are not constant also falls back to run-time initialization, which is easy to miss.

`constinit`, added in C++20, turns the question into a compile error. It does not change how the variable behaves. It requires that the variable be constant-initialized, and the compiler refuses to compile otherwise. `constinit_ok.cpp` puts it on the `constexpr` version and `constinit_fail.cpp` puts it on the plain one:

```bash
g++ -std=c++20 -O2 constinit_ok.cpp -o constinit_ok && ./constinit_ok; echo $?
g++ -std=c++20 -O2 constinit_fail.cpp -o constinit_fail
```

`echo $?` prints the program's exit code, and the program returns 0 when the value it reads is 69.

```
0
```

`constinit_ok.cpp` compiles and exits with 0. `constinit` adds no behavior to a variable that is already constant-initialized. It makes the compiler check that it is.

```
constinit_fail.cpp: In function ‘Plain& plain_instance()’:
constinit_fail.cpp:13:28: error: ‘constinit’ variable ‘c’ does not have a constant initializer
  13 |     static constinit Plain c;
     |                            ^
constinit_fail.cpp:13:28: error: call to non-‘constexpr’ function ‘Plain::Plain()’
constinit_fail.cpp:9:5: note: ‘Plain::Plain()’ declared here
   9 |     Plain() : value(69) {}
     |     ^~~~~
```

`Plain`'s constructor cannot run at compile time, so the variable needs a guard, and `constinit` turns that into a compile error naming the constructor instead of a guard that quietly stays on every call.

## The Other Way to Drop the Lock

GCC has a flag, `-fno-threadsafe-statics`, that removes the thread-safety machinery from local statics. It does not remove the flag. On GCC 13.3.0 (a separate check, not the machine the numbers above come from), compiling the plain struct with it still tests the guard byte before building the object and still sets it afterward, but the calls to `__cxa_guard_acquire` and `__cxa_guard_release` are gone. The guarantee that a second thread waits is gone with them. It is a different tradeoff from `constexpr`: the object is still built at run time, the check is still there, and two threads can now build it at once.


## Quick Reference

**Coming from other languages**

Runtimes that build global objects lazily have to protect that first build somehow, and the protection costs a check on every access plus a lock or a wait on the first. Moving the construction to a stage before the program runs removes the check, because nothing can observe the object unbuilt. The tradeoff is that the object has to be something that can be built that early, without running arbitrary code.

**The 90% mental model**

A function-local `static` is built on first use, and since C++11 the compiler has to make that thread-safe. It adds a guard variable, and every call to the function loads it, tests it and branches. Only the first call goes into the runtime library to build the object, and other threads that arrive while it is being built sleep until it is done. A `constexpr` constructor lets the compiler build the object at compile time, which removes the guard, the check and the wait, and `instance()` becomes one instruction that returns an address. `constinit` on the variable makes the compiler refuse to compile if the constructor cannot run that early. Without it, a constructor that stops being `constexpr` brings the guard back without any error.
