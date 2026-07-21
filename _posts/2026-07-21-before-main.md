---
layout: post
title: "Before and After main(): How C++ Programs Actually Start and End"
date: 2026-07-21
domain: language
permalink: /blog/language/before-main/
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

`main()` is not the first thing that runs in your program. Not close. By the time `main()` gets called, the kernel has loaded your binary, the C runtime has initialized, and every global and static object in your program has already been constructed. When `main()` returns, all of it runs again in reverse. This post covers what actually happens at both ends.

## How the Binary is Organized

Before a process starts, the program exists as an ELF (Executable and Linkable Format) binary on disk. The linker organized the compiled code and data into named sections, each with a specific role:

`.text` holds the executable machine code. Every function in your program lives here. The kernel maps this section as read-execute, not writable.

`.rodata` (read-only data) holds constants: string literals, `const` global values, `constexpr` tables. Mapped as read-only. Writing to a string literal in C++ is undefined behavior that typically produces a segfault because the kernel enforces the read-only mapping at the hardware level.

`.data` holds initialized global and static variables with non-zero initial values. If you write `int x = 42;` at file scope, `42` is stored in this section.

`.bss` (Block Started by Symbol) holds uninitialized or zero-initialized global and static variables. The section occupies no space in the binary file itself, just a size field. At process start, the OS allocates the required amount of memory and zero-initializes it. This is why zero-initialized globals are guaranteed to be zero in C++: the hardware zeroes the physical pages before they are mapped into the process, not because the compiler emitted zeroing instructions.

`.symtab` holds the symbol table used by the linker and debugger. `.rel[a].*` holds relocation information used when loading shared libraries. `.debug_*` sections hold DWARF debug information when compiled with `-g`. `.eh_frame` holds exception handling tables: for every function, the compiler emits a description of which destructors need to be called at each point if an exception unwinds through it. This is what makes C++ exceptions "zero-cost" when not thrown: the try/catch adds no instructions to the normal execution path, just this table sitting in the binary unused until an exception actually occurs.

## From Binary to Process: What the OS Does

When you run a program, the kernel does not simply start executing the first byte. The sequence is:

The kernel reads the ELF header to confirm the file is a valid executable and find the program headers. The program headers describe which segments to map into virtual memory and with what permissions: read-execute for `.text`, read-only for `.rodata`, read-write for `.data` and `.bss`. The mapping is lazy: pages are not backed by physical memory until first touch, which is the same lazy allocation covered in the prefaulting post.

If the binary uses shared libraries (which almost every C++ binary does: at minimum `libc` and `libstdc++`), the dynamic linker (`ld.so`) is loaded first and resolves those dependencies, mapping each shared library into the process address space and fixing up the Global Offset Table (GOT) so calls to library functions resolve to the correct addresses.

The OS sets up the initial stack, places `argc`, `argv`, and `envp` at known offsets, and then transfers control not to `main()` but to `_start`.

## _start and the C Runtime

`_start` is the actual entry point of the executable, the address the CPU jumps to when the process begins. It is not a C++ function in the normal sense: there is no caller to return to, and the stack is in a known but uninitialized state set up by the OS.

`_start` in glibc does a small amount of setup and then calls `__libc_start_main`, which is where most of the C runtime initialization happens:

- Sets up `argc`, `argv`, and `envp`
- Initializes thread-local storage
- Registers `atexit` handlers for C++ runtime cleanup
- Calls constructors for global and static C++ objects (via `__init_array`)
- Initializes the standard library, including the buffers for `std::cin`, `std::cout`, and `std::cerr`

Only after all of this completes does `__libc_start_main` call your `main()`.

## Global Constructors and the Static Initialization Order Fiasco

Every global object and every `static` variable at namespace scope has its constructor called before `main()`, in the order established by `__init_array`, a section the linker populates with pointers to each translation unit's initialization function.

Within a single translation unit (one `.cpp` file), the standard guarantees top-to-bottom construction order: globals defined earlier in the file are constructed before globals defined later. Across translation units, the standard says nothing. The order in which the linker processes object files, and therefore the order in which their initialization functions run, is implementation-defined.

This is the static initialization order fiasco (SIOF). If a global object in `file_a.cpp` depends on a global object in `file_b.cpp` already being constructed, there is no guarantee that is true. The symptom is typically a crash or garbage value on first use, reproducible only in some build configurations or link orders, and invisible in others.

```cpp
// file_a.cpp
extern std::string g_name;           // defined in file_b.cpp
std::string g_greeting = "Hello, " + g_name;  // may run before g_name is constructed

// file_b.cpp
std::string g_name = "world";
```

The canonical fix is to replace the global with a function-local static, which C++11 guarantees is initialized exactly once on first call, thread-safely:

```cpp
// file_a.cpp
const std::string& get_name() {
    static std::string name = "world";  // initialized on first call, C++11 guarantee
    return name;
}
std::string g_greeting = "Hello, " + get_name();  // safe: get_name() forces initialization
```

The local static approach works because function-local statics have a different initialization rule: they initialize on first execution of the declaration, not at program startup. C++11 added the thread-safety guarantee (sometimes called "magic statics"), meaning the initialization is protected against concurrent first calls without needing explicit synchronization.

GCC also provides `__attribute__((init_priority(N)))` as an extension to control initialization order within a translation unit, where lower `N` values run earlier. This is non-portable and a last resort, but it exists for situations where the function-static pattern cannot be applied.

## After main() Returns

When `main()` returns, control goes back to `__libc_start_main`, which calls `exit()`. `exit()` does the following in order:

1. Calls all functions registered with `atexit()` and `at_quick_exit()`, in reverse registration order
2. Calls destructors for all global and static objects, in reverse order of their construction
3. Flushes and closes all open C stdio streams (which includes the buffers backing `std::cout`)
4. Returns control to the OS, which reclaims the process's memory and file descriptors

This is why `std::cout` output appears even if you never explicitly call `std::cout.flush()`: the flush happens as part of the shutdown sequence. It also means a `std::vector` or any other RAII object at global scope will have its destructor called cleanly, including freeing its heap allocation, before the process ends.

## std::exit, abort, and terminate

Not all program endings go through this sequence.

`std::exit(int status)` (from `<cstdlib>`) runs the full shutdown: `atexit` handlers, global destructors, buffer flushes. Equivalent to `main()` returning `status`. Use this when you want a clean exit from somewhere other than `main()`.

`std::_exit(int status)` skips everything: no `atexit` handlers, no global destructors, no buffer flushes. The process terminates immediately. Output buffered in `std::cout` that has not been flushed will be lost. Used in the child process after `fork()` to avoid running parent cleanup handlers in the child.

`std::abort()` sends `SIGABRT` to the process, which terminates it without cleanup. No destructors, no flushes, no `atexit`. Produces a core dump if enabled. Called internally when the runtime detects an unrecoverable state: failed `assert`, pure virtual function call, out-of-range `std::vector::at` in some implementations.

`std::terminate()` is called when exception handling fails: an uncaught exception, an exception thrown during stack unwinding (covered below), or `noexcept` violated. By default it calls `std::abort()`. Can be replaced with `std::set_terminate()`, but the replacement function must not return.

## Quick Reference

**Coming from other languages**

The concept of code running before and after your entry point exists in most languages, but C++ exposes it more directly because of its value semantics and destructors. Garbage-collected languages have no deterministic destructor order, so the "run cleanup in reverse" guarantee does not exist in the same form. Languages without global constructors avoid the SIOF entirely. C++'s version of the problem comes directly from combining value semantics, constructors, and the ability to have complex objects at global scope, all of which are choices the language made for good reasons that happen to interact in this particular way.

**The 90% mental model**

`main()` is called by the C runtime, not by the OS. Before it runs: the OS maps the ELF sections into memory, the dynamic linker resolves shared libraries, `_start` hands off to the C runtime, which initializes the standard library and constructs every global and static object in the program. After `main()` returns: `exit()` destroys all globals and statics in reverse order, flushes all I/O buffers, then exits. The order of global construction across different source files is undefined, which is the SIOF. The fix is function-local statics, which initialize on first call. `std::abort()` and `std::terminate()` skip cleanup entirely. The fix for cross-file construction order is a function returning a reference to a local static, which constructs on first call and is thread-safe since C++11.
