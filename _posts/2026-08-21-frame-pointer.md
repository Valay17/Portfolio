---
layout: post
title: "The Frame Pointer: Check Your Default Before Reaching for the Flag"
date: 2026-08-21
domain: compiler
permalink: /blog/compiler/frame-pointer/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/frame-pointer"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

Every function call needs somewhere to put its local variables, its arguments, and the address to jump back to once it is done. That block of memory is a stack frame, and whether the compiler makes it easy to find depends on more than the optimization level. It depends on which compiler build is actually running, and the traditional assumption about what that means is now wrong on many systems.

## What Is in a Stack Frame

A stack frame is the region of stack memory belonging to one function invocation. It is created on `call` and destroyed on `ret`. Each frame holds:

- **Return address**: pushed automatically by the `call` instruction, popped by `ret`
- **Saved registers**: callee-saved registers the function uses (`rbx`, `rbp`, `r12` through `r15` on x86-64 System V ABI)
- **Local variables**: anything the compiler cannot keep in registers for the duration of the function
- **Overflow arguments**: the first six integer or pointer arguments go in registers (`rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`); the rest spill to the stack
- **Frame pointer (optional)**: the saved `rbp` from the caller, when frame pointers are in use

The stack pointer `rsp` always points to the top of the current frame. Allocating stack space is `sub rsp, N`. Freeing it is `add rsp, N` or equivalent on return. The mechanism is hardware-assisted LIFO with no external bookkeeping.

## The Frame Pointer Chain and Why Profilers Need It

The call stack is the sequence of all currently active frames, current function at the top, `main` near the bottom. The CPU only needs `rsp` and the return addresses to execute. It does not need to know where any prior frame starts.

Profilers and debuggers do. A profiler sampling the call stack has to reconstruct which functions are active. The traditional mechanism is the frame pointer chain: `rbp` holds the base of the current frame, and the frame itself stores the caller's `rbp` at that address. Walking `rbp → [rbp] → [[rbp]] → ...` reconstructs every active frame back to `main`.

Tools like `perf`, `gdb`, and flamegraph tools walk exactly that chain. If the chain was never built, stack traces come back broken or incomplete.

## The Instruction That Actually Matters

The natural assumption is that an `-O2` build simply leaves `rbp` untouched and the chain does not exist. Disassembling the code shows this assumption is imprecise in two ways.

First: `push rbp` and `pop rbp` can appear in a function even when there is no frame pointer chain. `rbp` is a callee-saved register and the compiler may push it at entry and pop it at exit purely to preserve its value, then use it as ordinary scratch space in between. That is not a frame pointer.

Second: the instruction that actually establishes a frame pointer is `mov rbp, rsp`, which appears right after `push rbp` when frame pointers are active. Its presence or absence is the test that matters, not whether `rbp` appears in the disassembly at all.

## Three Builds, Not Two

The actual behavior on a given machine is not settled by reading documentation about `-O2`. It requires checking what the compiler is actually doing. On this machine, compiling the same function three ways shows the full picture:

Default `-O2` already establishes a frame pointer: `mov rbp, rsp` appears right after `push rbp`. Adding `-fno-omit-frame-pointer` produces byte-identical output. The flag does nothing because there is nothing left to fix. The only way to get a build without a frame pointer chain is to pass `-fomit-frame-pointer` explicitly, the opposite of what most profiling guides say to add.

This is not a quirk of one machine. The reason traces to Nixpkgs injecting `-fno-omit-frame-pointer` into every build through its `cc-wrapper`. Ubuntu made the same decision for Ubuntu 24.04 LTS, in collaboration with Polar Signals, at roughly 1 to 2 percent overhead, and the change now appears in every package in the default repos. Fedora did the same starting with Fedora 38. The traditional assumption that `-O2` omits frame pointers is now wrong more often than it is right, and confirming the actual mechanism on your own machine takes one command.

## Checking Your Own Default

```bash
g++ -O2 -v -c codegen.cpp -o /dev/null 2>&1 | grep "cc1plus" | tr ' ' '\n' | grep -i frame
```

This prints the literal internal `cc1plus` invocation GCC uses, one flag per line, filtered to anything frame-related. Whatever appears here is what the compiler is doing, regardless of environment variables, wrappers, or assumptions about `-O2` defaults.

On a Nix-based environment, also check:

```bash
echo $NIX_CFLAGS_COMPILE
```

If the Nix `cc-wrapper` is injecting frame pointer flags, they appear here. On this machine they did not, only include paths, which ruled out that mechanism and pointed toward the `cc1plus` check instead.

## Key Insight

```cpp
extern int bar(int x);

int foo(int a) {
    int b = a + 10;
    return bar(b) + bar(b + 1);
}
```

`bar` is external and never defined, so it cannot be inlined. `foo` must call it twice and hold the first result somewhere across the second call. That temporary has to live in a callee-saved register. With frame pointers active, `rbp` is reserved for the chain and another register takes the temporary. With frame pointers omitted, `rbp` is available as scratch and the compiler uses it for the temporary instead, with no `mov rbp, rsp` anywhere.

## Run: default -O2

```bash
g++ -O2 -std=c++20 -c codegen.cpp -o codegen-o2.o
objdump -d -M intel --no-show-raw-insn codegen-o2.o
```

`-c` compiles to an object file without linking. `-M intel` selects Intel syntax. `--no-show-raw-insn` hides raw instruction bytes. Check specifically for `mov rbp, rsp` right after the initial `push rbp`. Its presence or absence determines whether this build already has a frame pointer chain.

## Run: -fno-omit-frame-pointer

```bash
g++ -O2 -fno-omit-frame-pointer -std=c++20 -c codegen.cpp -o codegen-o2-fp.o
objdump -d -M intel --no-show-raw-insn codegen-o2-fp.o
```

If the default build already had `mov rbp, rsp`, expect this output to be identical to it. If the default omitted it, expect this one to add it.

## Run: -fomit-frame-pointer

```bash
g++ -O2 -fomit-frame-pointer -std=c++20 -c codegen.cpp -o codegen-o2-omit.o
objdump -d -M intel --no-show-raw-insn codegen-o2-omit.o
```

The explicit opposite flag, forcing omission regardless of what the default is. This is the build to compare against the other two to see what omitted actually looks like: `rbp` still pushed and popped, but reused as plain scratch space between those two operations, no `mov rbp, rsp` anywhere.

## Output

```
$ objdump -d -M intel --no-show-raw-insn codegen-o2.o

0000000000000000 <foo(int)>:
   0:   push   rbp
   1:   mov    rbp,rsp
   4:   push   r12
   6:   push   rbx
   7:   mov    ebx,edi
   9:   lea    edi,[rdi+0xa]
   c:   call   11 <foo(int)+0x11>
  11:   lea    edi,[rbx+0xb]
  14:   mov    r12d,eax
  17:   call   1c <foo(int)+0x1c>
  1c:   pop    rbx
  1d:   add    eax,r12d
  20:   pop    r12
  22:   pop    rbp
  23:   ret

$ objdump -d -M intel --no-show-raw-insn codegen-o2-fp.o

(identical to codegen-o2.o above, byte for byte)

$ objdump -d -M intel --no-show-raw-insn codegen-o2-omit.o

0000000000000000 <foo(int)>:
   0:   push   rbp
   1:   push   rbx
   2:   mov    ebx,edi
   4:   lea    edi,[rdi+0xa]
   7:   sub    rsp,0x8
   b:   call   10 <foo(int)+0x10>
  10:   lea    edi,[rbx+0xb]
  13:   mov    ebp,eax
  15:   call   1a <foo(int)+0x1a>
  1a:   add    rsp,0x8
  1e:   add    eax,ebp
  20:   pop    rbx
  21:   pop    rbp
  22:   ret
```

Default `-O2` has `mov rbp,rsp` at offset 1: frame pointer chain present. `-fno-omit-frame-pointer` is byte-for-byte identical, confirming the flag was redundant. `-fomit-frame-pointer` has no `mov rbp,rsp` anywhere. `rbp` is pushed at offset 0 and popped at offset 21, but at offset 13 it holds `eax`, the result of the first `bar` call, plain scratch space. The temporary that needed a callee-saved register moved from `r12` in the first two builds to `rbp` in this one, which is exactly what the compiler does when `rbp` is free.

## The x86-64 Calling Convention

The System V AMD64 ABI governs how function calls work on Linux and macOS. The first six integer or pointer arguments go in `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`. The seventh and beyond go on the stack. Floating-point arguments go in `xmm0` through `xmm7`. Return values land in `rax` for integers and pointers, `xmm0` for floats.

Callee-saved registers (`rbx`, `rbp`, `r12` through `r15`) must be preserved across a call: save on entry, restore before return. Everything else is caller-saved and the caller is responsible for preserving anything it needs before a call.

Windows uses a different convention: first four arguments in `rcx`, `rdx`, `r8`, `r9`, plus a mandatory 32-byte shadow space on the stack the caller allocates. Object files built for Windows and Linux are not compatible even on identical hardware.

## Stack vs Heap

Stack allocation is `sub rsp, N`, a single instruction with no allocator involvement. Freeing it on return is the corresponding add. The cost is effectively zero.

Heap allocation calls into the allocator, which maintains a free-block data structure, may call into the kernel for more memory, and must handle fragmentation. Latency is non-deterministic and every allocation carries metadata overhead.

The stack's cost is its limit. On Linux, the default per-thread stack is 8 MB shared across all nested calls. A function declaring `std::array<float, 500000>` as a local consumes 2 MB for every invocation. Stack overflow produces `SIGSEGV` with no diagnostic pointing at the cause.

## VLAs, alloca, and Stack Canaries

Variable-length arrays (VLAs) and `alloca` both adjust `rsp` by a runtime value rather than a compile-time constant. The risk is the same as a large static array but harder to audit: there is no allocation failure for stack memory, just a silent overflow and `SIGSEGV`.

Stack canaries address a separate risk: buffer overflows that corrupt the return address. The compiler places a known value between the local variables and the return address at function entry, then checks it before returning. `-fstack-protector-strong` enables this for functions with local buffers or address-of operations on locals. The canary is randomized at process start. It detects overflow before the corrupted return address is used, but it does not prevent the overflow.

## Tail Call Optimization and Per-Thread Stacks

When the last thing a function does is call another function and return its result directly, the compiler can replace the `call` with a `jmp`, reusing the current frame. The recursion depth becomes constant stack usage regardless of how many iterations run. C++ does not guarantee this, local objects with destructors or differing signatures between caller and callee can prevent it, but GCC applies it at `-O2` where the pattern is clear.

Each thread gets its own stack at creation time. All threads share the same `.text` section, heap, and global variables. Per-thread global or static state uses thread-local storage (TLS), declared with `thread_local` in C++11. The compiler accesses TLS through the `fs` segment register on Linux x86-64, pointing each thread to its own block initialized from the binary's TLS template at thread creation.

## Quick Reference

**Coming from other languages**

Most managed languages hide the call stack as a runtime implementation detail. The frame pointer chain as a profiler tool is specific to native code where tools like `perf` must reconstruct execution context from whatever the binary left in registers and memory. The correctness of that reconstruction depends entirely on whether the chain was built.

**The 90% mental model**

Every function call pushes a stack frame holding the return address, saved registers, and local variables. The frame pointer `rbp` creates a linked chain the profiler can walk, but only when `mov rbp, rsp` appears after the initial `push rbp`. That one instruction is the test. `-O2` may or may not include it depending on which compiler build is running: modern distros (Ubuntu 24.04, Fedora 38, Nixpkgs) now default to frame pointers on. Check with `g++ -O2 -v -c file.cpp -o /dev/null 2>&1 | grep cc1plus | tr ' ' '\n' | grep frame` before assuming `-fno-omit-frame-pointer` is needed. It may already be on, and `-fomit-frame-pointer` may be what actually changes something.
