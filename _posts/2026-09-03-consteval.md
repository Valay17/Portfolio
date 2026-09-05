---
layout: post
title: "consteval: A Compile-Time Function That Doesn't Take No for an Answer"
date: 2026-09-03
domain: compiler
permalink: /blog/compiler/consteval/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/consteval"
linkedin: "https://www.linkedin.com/posts/activity-7501325409104314372-o1Zd/"
---

Call a `constexpr` function and it permits compile-time evaluation but does not require it but call it with a runtime argument and it runs at runtime, silently, with no indication in the source that anything went differently than expected. `consteval` closes that gap completely.

## What an Immediate Function is

The C++ standard calls a `consteval` function an **immediate function**. Every call to an immediate function must itself be a constant expression, or the program is ill-formed. There is no fallback path, no runtime version, no silently-slower alternative. If the compiler cannot evaluate the call at compile time, the build fails.

```cpp
consteval int square(int n) { return n * n; }

int runtime_call(int x) {
    return square(x);   // x is not known at compile time
}
// error: call to consteval function 'square(x)' is not a constant expression
// error: 'x' is not a constant expression
```

The errors name both the call and the specific reason the call could not be evaluated. Nothing compiles. No binary is produced.

An **immediate invocation** is a related concept: a `consteval` call that appears within a non-constexpr context but whose arguments happen to be constant expressions. The compiler evaluates it during translation regardless of the surrounding context. The function does not "run" at runtime in the sense of generating instructions; the result is substituted as a constant and the call disappears.

```cpp
int a = square(7);   // immediate invocation: square(7) is evaluated at compile time
                     // even though this is a runtime-context variable declaration
                     // a = 49, no call instruction generated
```

This is different from `constexpr`: a `constexpr` function called with constant arguments in a runtime context is allowed to be evaluated at runtime. An immediate function called with constant arguments anywhere is always evaluated at compile time, because there is no other option.

## The Flipped Guarantee

The `constexpr` post showed that the only way to confirm a `constexpr` function ran at compile time is to look for it: `static_assert`, `constexpr` variable declaration, or disassembly. The function itself gives no guarantee.

`consteval` inverts this. You do not need to look for evidence of compile-time evaluation because any other outcome is a compile error. The guarantee is structural: if the binary exists, every call to every `consteval` function in it was evaluated at compile time. If any call could not be, the binary does not exist.

This changes the failure mode from silent performance regression (constexpr running at runtime undetected) to a build error (consteval refusing to compile). For functions whose correctness depends on compile-time evaluation, that is the right failure mode.

## consteval Cannot Be Called Through a Function Pointer

`consteval` functions do not exist at runtime. There is no address to take. Attempting to take the address of a `consteval` function or store it in a function pointer is a compile error:

```cpp
consteval int square(int n) { return n * n; }

auto fp = &square;       // error: taking address of consteval function
int (*fptr)(int) = square; // error: same
```

This is a hard constraint rather than an optimization. Since the function has no runtime representation, there is nothing to point to. This also means `consteval` functions are not subject to ODR in the usual sense: they produce no object code, so there is no symbol for the linker to deduplicate or conflict.

## The User-Defined Literal Bug consteval was Made to Fix

This is where `consteval` earns its place in practice. The pattern is a user-defined literal operator meant to validate its input at compile time, commonly used for units, bounded integers, percentages, or similar types where a value outside the valid range is a programming error rather than a runtime condition.

The validation trick inside a `constexpr` operator is to throw inside the function when the input is invalid. Throwing in a constant expression context makes the expression ill-formed, rejecting the program at compile time. The throw never fires at runtime for a valid value because the whole call was already folded into a constant.

The problem is that `constexpr` only permits compile-time evaluation. Call the operator directly as a plain function rather than through literal syntax, passing something the compiler cannot resolve ahead of time, and the throw becomes an ordinary runtime throw:

```cpp
// constexpr version: validation logic exists but is not guaranteed to run at compile time
constexpr unsigned long long operator""_pct(unsigned long long v) {
    if (v > 100) throw std::out_of_range("percentage out of range");
    return v;
}

int main(int argc, char**) {
    int bad = operator""_pct(150ULL + argc);   // argc not known at compile time
    // compiles cleanly, throws at runtime instead of rejecting at compile time
}
```

This compiles. The range check runs at runtime. If the path is never exercised during testing, the bug ships to production.

Changing `constexpr` to `consteval` closes the gap outright:

```cpp
consteval unsigned long long operator""_pct(unsigned long long v) {
    if (v > 100) throw std::out_of_range("percentage out of range");
    return v;
}
```

The same call, `operator""_pct(150ULL + argc)`, is now a compile error. `argc` is not a constant expression, so the call cannot be evaluated at compile time, so the build fails. The program that compiled and crashed at runtime under `constexpr` is rejected before it exists as a binary under `consteval`.

Legitimate use through literal syntax with a compile-time-known value works exactly as before:

```cpp
int good = 50_pct;   // fine: 50 is a constant, evaluated at compile time
```

## consteval and std::is_constant_evaluated()

Inside a `consteval` function, `std::is_constant_evaluated()` always returns true. This is by definition: the function can only ever be called in a constant expression context, so the evaluator is always running. The two-path pattern that `std::is_constant_evaluated()` enables in `constexpr` functions, where one branch runs at compile time and another at runtime, has no use inside a `consteval` function since the runtime branch can never be taken.

A `consteval` function can call `constexpr` functions freely. The call happens in a compile-time context (since the `consteval` function is always in one), so the `constexpr` function will be evaluated at compile time.

A `constexpr` function can call a `consteval` function, but only in a context that is itself a constant expression. If the `constexpr` function is being evaluated at runtime and attempts to call a `consteval` function, the call is ill-formed.

```cpp
consteval int double_it(int n) { return n * 2; }

constexpr int use_it(int n) {
    return double_it(n);   // fine if use_it is called in a constant expression context
                           // error if use_it is called at runtime with a non-const n
}

constexpr int a = use_it(5);   // fine: constant context, double_it(5) = 10
int b = use_it(x);             // error: double_it called at runtime
```

## Run: fail.cpp

```bash
g++ -O2 -std=c++26 -c fail.cpp -o fail.o
```

Expected to fail. Expect an error naming `x` as not a constant expression.

## Run: udl_bug.cpp

```bash
g++ -O2 -std=c++26 udl_bug.cpp -o udl_bug && ./udl_bug
```

This compiles and runs. The `constexpr` operator is called directly as a function with `150ULL + argc`. Expect the build to succeed and the program to terminate with an uncaught `std::out_of_range` at runtime.

## Run: udl_fix_valid.cpp

```bash
g++ -O2 -std=c++26 udl_fix_valid.cpp -o udl_fix_valid && ./udl_fix_valid
```

Same validation logic, `consteval` instead of `constexpr`, called through literal syntax with a valid compile-time value. Expect this to compile and run normally.

## Run: udl_fix_invalid.cpp

```bash
g++ -O2 -std=c++26 -c udl_fix_invalid.cpp -o udl_fix_invalid.o
```

Expected to fail. Same call as `udl_bug.cpp` but on the `consteval` version. Expect an error naming `argc` as not a constant expression.

## Output

```
$ g++ -O2 -std=c++26 -c fail.cpp -o fail.o
fail.cpp: In function 'int runtime_call(int)':
fail.cpp:12:18: error: call to consteval function 'square(x)' is not a constant expression
   12 |     return square(x);
      |            ~~~~~~^~~
fail.cpp:12:19: error: 'x' is not a constant expression
   12 |     return square(x);
      |                   ^
```

Two errors on this GCC version: the first names the call, the second names the specific non-constant piece.

```
$ g++ -O2 -std=c++26 udl_bug.cpp -o udl_bug && ./udl_bug
terminate called after throwing an instance of 'std::out_of_range'
  what():  percentage out of range
Aborted
```

Compiles clean, crashes on execution. The validation logic exists and fires, it just fires at runtime instead of rejecting the build.

```
$ g++ -O2 -std=c++26 udl_fix_valid.cpp -o udl_fix_valid && ./udl_fix_valid
good = 50
```

`consteval` does not interfere with legitimate compile-time-known literal use.

```
$ g++ -O2 -std=c++26 -c udl_fix_invalid.cpp -o udl_fix_invalid.o
udl_fix_invalid.cpp: In function 'int main(int, char**)':
udl_fix_invalid.cpp:16:29: error: call to consteval function 'operator""_pct((((long long unsigned int)argc) + 150))' is not a constant expression
   16 |     int bad = operator""_pct(150ULL + argc);
      |               ~~~~~~~~~~~~~~^~~~~~~~~~~~~~~
udl_fix_invalid.cpp:16:39: error: 'argc' is not a constant expression
   16 |     int bad = operator""_pct(150ULL + argc);
      |                                       ^
```

The exact same call that compiled and crashed at runtime under `constexpr` is rejected before it becomes a binary under `consteval`. The error even echoes the full expression it attempted to evaluate before naming `argc` as the non-constant piece.

## Quick Reference

**Coming from other languages**

Most languages with compile-time computation either require it (constants must always be computed at compile time) or don't expose the distinction at the language level at all. C++'s split between `constexpr` (permitted) and `consteval` (required) is unusual: it gives the programmer explicit control over which guarantee applies, at the cost of needing to understand the distinction. Languages that enforce compile-time evaluation uniformly avoid the `constexpr`-runs-at-runtime problem by construction but are correspondingly more restrictive about what can be a compile-time function.

**The 90% mental model**

`consteval` means the function must be evaluated at compile time at every call site, no exceptions. Call it with a non-constant argument and the build fails. The function produces no runtime code, has no address, and cannot be stored in a function pointer. The primary practical use beyond the obvious (forced compile-time computation) is closing the validation gap in user-defined literals: a `constexpr` literal operator with a range check can silently compile and ship a runtime crash if called with a non-constant argument; a `consteval` literal operator makes that call a compile error instead. Inside a `consteval` function, `std::is_constant_evaluated()` always returns true and there is no runtime path to branch to.
