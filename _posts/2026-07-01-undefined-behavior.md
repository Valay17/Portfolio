---
layout: post
title: "Undefined Behavior and the Disappearing Overflow Check"
date: 2026-07-01
domain: compiler
permalink: /blog/compiler/undefined-behavior/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/undefined-behavior"
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7478030093853061120-YsmE"
---

A line of code that checks for integer overflow can disappear completely, not because of some aggressive optimization flag, but because the compiler decided the check could never be true.

## The Standard's Rule, and What the Compiler Does With It

Signed integer overflow is undefined behavior in C++. Not implementation-defined, not guaranteed to wrap, undefined. The standard says it cannot happen in a correct program, full stop. The compiler is allowed to take that as a hard rule it can build on, not a soft warning it should account for defensively.

```cpp
bool will_overflow(int x) {
    if (x + 1 < x) {
        return true;
    }
    return false;
}
```

This function is written to catch overflow: if adding 1 to `x` wraps a signed integer around to something smaller, the comparison should catch it. But the standard says `x + 1` overflowing is something that can never legally happen in a defined program. The compiler is permitted to reason backward from that rule: since the input that would make this condition true is by definition not a case the standard requires it to handle, the condition can be treated as always false. Once the condition is always false, the entire branch that returns `true` is dead code, and the function collapses to an unconditional `return false`, with no comparison instruction left anywhere in the generated code.

This is not a compiler bug. It is the compiler using exactly the freedom the standard grants it. The check written to protect against overflow becomes the thing standing between the program and a bug, except it never executes.

## UB as a Contract, Not a Runtime Event

The reason this is legal comes down to what undefined behavior actually means in the standard. UB is not a runtime occurrence the compiler tolerates, observes, and then reports or works around. It is a precondition. The standard's guarantees about what a program does are conditional on undefined behavior never occurring anywhere in that program's execution. The moment it does occur, the standard makes no claim about the program at all, not just about the operation that triggered it, the entire execution becomes unconstrained from that point in any direction, forward or backward.

This is what licenses the compiler to optimize as if UB never happens, rather than defensively as if it might. If a program path requires UB to have already occurred to reach a particular state, the compiler is permitted to treat that path as unreachable in a correct program, because a correct program by definition never triggers UB. `x + 1 < x` can only be true if `x + 1` already overflowed, which the standard says cannot happen in a program that conforms. So the compiler does not need to ask whether the input might cause overflow, it is allowed to assume the input never does, and optimize on that assumption directly. This is the same reasoning behind a wide class of optimizations, not just this one function: every time the compiler eliminates a bounds check, hoists a load above a branch, or assumes two pointers do not alias, it is leaning on some version of the same contract, that the programmer has guaranteed UB will not occur, and the compiler is free to generate code that is only correct under that guarantee.

## This Pattern Shows Up Beyond Integer Overflow

The disappearing overflow check is one instance of a broader class of bug, not an isolated quirk specific to signed arithmetic. Anywhere a check exists whose own logic depends on UB having already happened, the same elimination is legal.

A common instance in practice is a null check placed after a pointer has already been dereferenced:

```cpp
int read_value(int* ptr) {
    int val = *ptr;           // dereference happens first
    if (ptr == nullptr) {     // too late, this check can be removed
        return -1;
    }
    return val;
}
```

Dereferencing a null pointer is undefined behavior. By the time the null check runs, the dereference has already happened. Under the same reasoning as the overflow case, the compiler is permitted to conclude that since reaching the null check at all required `ptr` to have already been successfully dereferenced, `ptr` cannot have been null in any execution that does not already involve UB, and the check can be eliminated entirely. The fix is the same shape as the overflow fix: check before the operation that depends on the precondition, not after.

### Confirming the Null Pointer Case Directly

Same file, `main` calling `read_value(nullptr)` with a pointer known at compile time, compiled several separate ways.

At `-O0`, the function is a literal translation: `*ptr` is dereferenced first, the null check runs after, on both the default build and a build compiled with `-fno-delete-null-pointer-checks`, a flag that exists specifically to stop the compiler from deleting checks like this one. `-O0` does not reason about pointer nullness either way, so the flag makes no difference at this level.

At `-O2` with no extra flags, `read_value` on its own loses the check entirely, becoming a two-instruction unconditional dereference. `main`, which calls it with a compile-time-known `nullptr`, gets something sharper than a deletion:

```
0000000000000000 <main>:
   0:   mov    eax,DWORD PTR ds:0x0
   7:   ud2
```

`ud2` is an x86 instruction whose entire purpose is to be illegal. The compiler proved, at compile time, that this call path dereferences null unconditionally, so instead of generating the dereference or anything that computes a plausible answer, it emits an instruction that raises an invalid-opcode exception the moment the CPU reaches it, `SIGILL`, not the `SIGSEGV` a plain null dereference would produce. The CPU never attempts the memory access, it refuses to execute the instruction at all.

Adding `-fno-delete-null-pointer-checks` at `-O2` brings the check back:

```
0000000000000000 <read_value(int*)>:
   0:   mov    eax,DWORD PTR [rdi]          <-- still dereferences first
   2:   test   rdi,rdi                      <-- check preserved, but too late
   5:   je     8 <read_value(int*)+0x8>
   7:   ret
   8:   mov    eax,0xffffffff
   d:   ret
```

But look at the order. Line `0` still dereferences `[rdi]` before line `2` tests whether it is null. The flag stops the compiler from deleting the check, it does not move the check earlier than the dereference, because that ordering came from the source, not the optimizer. This build avoided a crash in this specific test only because `main` passes a literal `nullptr`, letting the compiler resolve the whole call through the now-preserved check without ever touching memory. A pointer whose value is not known until runtime would still dereference before checking, flag or no flag.

That distinction matters enough to test directly. Calling `read_value` with a pointer built from a command line argument, something the compiler has no way to reason about at compile time, removes the `ud2` entirely:

```
0000000000000000 <main>:
   ...
  1b:   mov    esi,DWORD PTR [rax]    <-- dereference inlined directly, no check
   ...
```

`grep -c "ud2"` on this binary returns `0`. `main` just inlines the already-checkless dereference. Run it with a null pointer at runtime and the result is a plain `Segmentation fault`, not the illegal-instruction crash from before. The `ud2` trap only exists when the compiler can prove a specific call is null at compile time. Take that knowledge away and the missing check does not announce itself with a loud, deliberate crash, it just faults wherever the dereference happens to land, or worse, silently reads whatever happens to be at that address if it happens to be mapped.

A related case shows up with `this` inside a member function:

```cpp
void Widget::doSomething() {
    if (this == nullptr) {   // can be optimized away
        return;
    }
    // ...
}
```

Calling a non-static member function through a null pointer is undefined behavior in C++. The moment the function body is executing at all, the compiler is permitted to assume `this` was never null, since a call through a null `this` is not behavior the standard defines, and the check can be removed under the same logic as the other two cases. This one used to work reliably on many older compilers, since `this` was often just an ordinary register passed by convention, with no enforcement either way. It is reliably eliminated by modern compilers with all the warnings this section already describes, and code depending on it surviving is depending on UB by definition, not on a guarantee.

Loop bounds built on signed overflow are a third common case: a loop written as `for (int i = 0; i + 1 > i; ++i)` intending to run until `i` wraps relies on the same overflow the first example does, and is just as eligible for the compiler to treat as either an infinite loop or a loop with a statically known bound, depending on what else the compiler can prove about `i`, rather than the wrapping behavior the code visually suggests.

The common thread across all of these: any check guarding against a condition that can only be reached by UB already having occurred is not a safety net. It is dead code the compiler is free to remove, because a program in which that check would matter is, by the standard's own definition, not a program the compiler has to produce correct output for.

## Confirming It Directly

This is the kind of claim worth checking rather than taking on faith, since it sounds aggressive enough to doubt. Compiling `will_overflow` and disassembling it shows the function compiles down to an unconditional return, no comparison instruction exists anywhere in the binary, confirmed at both `-O0` and `-O2` specifically to test the assumption that this kind of elimination needs an aggressive optimization level. It does not, the fold happens at `-O0` too, the parameter is stored to the stack and never read back.

```bash
g++ -O0 -std=c++20 overflow-ub.cpp -o overflow-ub-o0
objdump -d -M intel --no-show-raw-insn overflow-ub-o0
g++ -O2 -std=c++20 overflow-ub.cpp -o overflow-ub-o2
objdump -d -M intel --no-show-raw-insn overflow-ub-o2
```

Compiling the same source with `-fwrapv` instead, which tells the compiler overflow wraps instead of being undefined, brings the check back at both optimization levels too. An actual comparison instruction appears in the disassembly where there was nothing before, since the compiler is no longer permitted to assume the overflow case is impossible.

```bash
g++ -O0 -std=c++20 -fwrapv overflow-ub.cpp -o overflow-ub-o0-wrapv
objdump -d -M intel --no-show-raw-insn overflow-ub-o0-wrapv
g++ -O2 -std=c++20 -fwrapv overflow-ub.cpp -o overflow-ub-o2-wrapv
objdump -d -M intel --no-show-raw-insn overflow-ub-o2-wrapv
```

One detail worth calling out on its own: the UBSan build below does not just report the overflow, it produces the numerically correct answer too. That is not a coincidence. Instrumenting the addition to detect overflow means the compiler cannot simultaneously prove the addition dead and delete it, so the actual `add` instruction still executes, and x86 addition wraps in hardware at the ALU level regardless of what the language calls undefined. `INT_MAX + 1` wraps to `INT_MIN` on the chip whether or not the standard permits the compiler to assume that never happens. Under UBSan, the comparison runs against that hardware-correct wrapped value, `true`, which is what a person mentally simulating wraparound arithmetic would expect, while the sanitizer separately reports that the addition itself was undefined behavior. The default build gives neither, no report and the wrong answer. The `-fwrapv` build gives the right answer with no report. UBSan is the only one of the three that gives both.

## What the Code Demonstrates

One file, compiled several separate ways, each its own invocation, at both `-O0` and `-O2` for the default and `-fwrapv` builds specifically to check whether the elimination needs an aggressive optimization level.

The default build shows what the compiler does with no special instruction either way: the standard says signed overflow cannot happen, so the comparison meant to detect it gets treated as always false and removed, at `-O0` as much as `-O2`.

The `-fwrapv` build tells the compiler overflow wraps instead of being undefined, which makes the comparison meaningful again under that explicit assumption, and the check reappears in the generated code at both optimization levels, not identical to the default build the way it might look on paper.

The `-fsanitize=undefined` build does not change what the optimizer assumes at compile time in the same silent way, it instruments the binary to catch undefined behavior at the moment it actually happens at runtime and reports it directly. One practical note: UBSan writes its diagnostic to stderr, not stdout, and defaults to recover mode, logging the violation and continuing execution rather than stopping, so the exit code stays 0 either way. A run that only checks stdout, or only checks the exit code, can look identical to a missed detection even when the sanitizer caught it correctly. Redirecting stderr into the same stream, or building with `-fno-sanitize-recover=undefined` to stop at the first violation instead of continuing, removes that ambiguity.

## Run: default build

```bash
g++ -O0 -std=c++20 overflow-ub.cpp -o overflow-ub-o0
objdump -d -M intel --no-show-raw-insn overflow-ub-o0
g++ -O2 -std=c++20 overflow-ub.cpp -o overflow-ub-o2
objdump -d -M intel --no-show-raw-insn overflow-ub-o2
./overflow-ub-o2
```

`objdump -d` disassembles the binary. `-M intel` selects Intel syntax over the default AT&T syntax. `--no-show-raw-insn` hides the raw instruction bytes.

```
-O0 default build:

0000000000000000 <will_overflow(int)>:
   0:   push   rbp
   1:   mov    rbp,rsp
   4:   mov    DWORD PTR [rbp-0x4],edi   <-- x stored, never read again
   7:   mov    eax,0x0                   <-- unconditional false
   c:   pop    rbp
   d:   ret
```
`x` is stored to the stack (`mov DWORD PTR [rbp-0x4],edi`) but never read again. The next line sets the return value to `0` unconditionally. Even at `-O0`, normally the level with the least reasoning applied, the compiler had already folded the check to constant false before the argument was ever used for anything.

```
-O2 default build:

0000000000000000 <will_overflow(int)>:
   0:   xor    eax,eax                   <-- unconditional false
   2:   ret
```
Same result as `-O0`, just in its most compact form. `xor eax,eax` is the standard idiom for zeroing a register cheaply, this is "return false" with no parameter read at all.

```
$ ./overflow-ub-o2
0
```
The default build's own printed output, confirming the disassembly directly. The check is gone, so the answer is always `false`, no matter what `x` actually is. This is the version that ships if nobody thinks to check.

## Run: -fwrapv build

```bash
g++ -O0 -std=c++20 -fwrapv overflow-ub.cpp -o overflow-ub-o0-wrapv
objdump -d -M intel --no-show-raw-insn overflow-ub-o0-wrapv
g++ -O2 -std=c++20 -fwrapv overflow-ub.cpp -o overflow-ub-o2-wrapv
objdump -d -M intel --no-show-raw-insn overflow-ub-o2-wrapv
./overflow-ub-o2-wrapv
```

`-fwrapv` tells the compiler that signed integer overflow wraps around using two's complement, rather than being undefined. This is an explicit contract the compiler is told to assume instead of relying on the standard's default undefined behavior rule, which is why the check becomes meaningful again under it.

```
-O0 -fwrapv build:

0000000000000000 <will_overflow(int)>:
   0:   push   rbp
   1:   mov    rbp,rsp
   4:   mov    DWORD PTR [rbp-0x4],edi
   7:   cmp    DWORD PTR [rbp-0x4],0x7fffffff   <-- comparison against INT_MAX
   e:   jne    17 <will_overflow(int)+0x17>
  10:   mov    eax,0x1
  15:   jmp    1c <will_overflow(int)+0x1c>
  17:   mov    eax,0x0
  1c:   pop    rbp
  1d:   ret
```
The source's literal `x + 1 < x` is not translated step by step even here. Instead of computing `x + 1` and comparing it to `x`, the compiler already reduces the whole condition to a direct comparison against `INT_MAX` (`0x7fffffff`), because under wraparound semantics that comparison is the exact condition, `x + 1 < x` is true if and only if `x == INT_MAX`.

```
-O2 -fwrapv build:

0000000000000000 <will_overflow(int)>:
   0:   cmp    edi,0x7fffffff               <-- comparison against INT_MAX
   6:   sete   al                           <-- sets return value from that comparison
   9:   ret
```
Same comparison as `-O0`, in its compact form. `sete al` is the x86 instruction for "set byte if equal", it writes `1` into the low byte of the return register if the preceding `cmp` found the two values equal, `0` otherwise, the branchless way to turn a comparison directly into a boolean return value.

```
$ ./overflow-ub-o2-wrapv
1
```
The `-fwrapv` build's printed output. `x` is `2147483647`, exactly `INT_MAX`, so the preserved comparison correctly evaluates to `true`. This is the answer a person reasoning about wraparound arithmetic by hand would expect.

## Run: UBSan build

```bash
g++ -O0 -std=c++20 -fsanitize=undefined -g overflow-ub.cpp -o overflow-ub-o0-ubsan
./overflow-ub-o0-ubsan 2>&1
g++ -O2 -std=c++20 -fsanitize=undefined -g overflow-ub.cpp -o overflow-ub-o2-ubsan
./overflow-ub-o2-ubsan 2>&1
```

`-fsanitize=undefined` links in UBSan, which instruments arithmetic and other operations to detect undefined behavior at runtime and report it immediately, including exactly where in the source it happened. `-g` keeps debug symbols so the runtime report includes a source file and line number rather than just an address. `2>&1` merges stderr into the same stream as stdout, since the diagnostic is written to stderr and is otherwise easy to miss.

```
$ ./overflow-ub-o0-ubsan 2>&1
overflow-ub.cpp:38:11: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'
1
```
The diagnostic fires even at `-O0`, on stderr. The program keeps running afterward, prints `1`, and exits normally, since UBSan's default mode logs the violation and continues rather than stopping.

```
$ ./overflow-ub-o2-ubsan 2>&1
overflow-ub.cpp:38:11: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'
1
```
Same diagnostic, same line and column, this time at `-O2`. The sanitizer's instrumentation fires independently of optimization level, even though the surrounding code shape in the non-sanitized builds above is completely different between `-O0` and `-O2`. The `1` here is the correct answer under wraparound arithmetic, for the reason explained above, instrumenting the addition means the compiler cannot also prove it dead and delete it.

## Does the compiler need to know the value in advance?

Both examples above call with a literal value, `2147483647` for the overflow check, `nullptr` for the pointer example. That can look like the trick only works because the compiler already knows the answer. It does not work that way for the check itself. It does matter for one specific detail in the nullptr example.

### Run: overflow example, argument from the command line

```bash
g++ -O2 -std=c++20 -c overflow-ub-argv.cpp -o overflow-argv-o2.o
objdump -d -M intel --no-show-raw-insn overflow-argv-o2.o | grep -A 5 "will_overflow"
g++ -O2 -std=c++20 overflow-ub-argv.cpp -o overflow-argv
./overflow-argv 2147483647
```

```
0000000000000000 <will_overflow(int)>:
   0:   xor    eax,eax
   2:   ret
```
`x` here comes from the command line, unknown until the program runs. The check still collapses to the same unconditional false as the literal-argument version. The elimination is a proof that holds for every possible `x` under the assumption that `x + 1` cannot overflow, not a fact about one specific input.

```
$ ./overflow-argv 2147483647
0
```

### Run: nullptr example, pointer from the command line

```bash
g++ -O2 -std=c++20 -c nullptr-ub-argv.cpp -o nullptr-argv-o2.o
objdump -d -M intel --no-show-raw-insn nullptr-argv-o2.o | grep -A 15 "^0000000000000000 <main>"
objdump -d -M intel nullptr-argv-o2.o | grep -c "ud2"
g++ -O2 -std=c++20 nullptr-ub-argv.cpp -o nullptr-argv
./nullptr-argv 0
```

```
0000000000000000 <main>:
   0:   push   rbp
   1:   mov    rdi,QWORD PTR [rsi+0x8]
   5:   mov    edx,0xa
   a:   xor    esi,esi
   c:   mov    rbp,rsp
   f:   call   14 <main+0x14>
  14:   lea    rdi,[rip+0x0]        # 1b <main+0x1b>
  1b:   mov    esi,DWORD PTR [rax]    <-- dereference inlined directly, no check
  1d:   call   22 <main+0x22>
  22:   mov    edx,0x1
  27:   lea    rsi,[rip+0x0]        # 2e <main+0x2e>
  2e:   mov    rdi,rax
  31:   call   36 <main+0x36>
  36:   xor    eax,eax
  38:   pop    rbp

ud2 count: 0
```
With a pointer the compiler cannot resolve at compile time, the binary contains no `ud2` instruction anywhere. `main` inlines the already-checkless dereference directly at `1b`, no trap, no defensive instruction of any kind.

```
$ ./nullptr-argv 0
Segmentation fault (core dumped)
```
`SIGSEGV`, not `SIGILL`. The trap in the earlier example existed only because the compiler could prove, at compile time, that the one call in `main` was unconditionally null. Take that knowledge away and the missing check does not announce itself, it just crashes wherever the dereference happens to land.

### What this means for the two examples above

The check being gone generalizes to every input, that is what makes it dangerous. The `ud2` trap is the part that depends on compile-time knowledge, and losing that knowledge does not make the code safer, it just makes the failure quieter and further from the actual mistake.

## Quick Reference

**Coming from other languages**

Most languages either define integer overflow precisely, wrapping or trapping deterministically, or they avoid the question by using arbitrary precision integers by default, growing instead of overflowing. C++ inheriting undefined behavior here instead of either of those choices is a difference in philosophy, not just a syntax difference, and it is specifically why a check that looks correct in isolation can vanish at compile time in a way it would not in a language that defines overflow's behavior rather than forbidding it. This is not a niche corner of the type system either, C++20 fixed the bit representation of signed integers to two's complement (P0907), but explicitly kept overflow itself undefined, on purpose, because that undefinedness is what lets a sanitizer flag every instance of it as a bug, and what lets the optimizer make the exact elimination this post demonstrates.

**The 90% mental model**

If a check exists specifically to catch something the standard calls undefined behavior, the compiler is allowed to assume that situation never occurs and optimize accordingly, including removing the check itself. Undefined behavior is not a runtime event the compiler tolerates and reports. It is a precondition the compiler is permitted to assume true and build other guarantees on top of. Catch overflow before it happens with a check that works under defined arithmetic, such as comparing against `INT_MAX` directly before the addition, or use a tool like UBSan that observes actual runtime behavior, rather than writing a check whose own logic depends on the undefined case already having occurred.
