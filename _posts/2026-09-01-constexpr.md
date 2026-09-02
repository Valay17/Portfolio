---
layout: post
title: "constexpr: Allowed to Run at Compile Time, Not Required To"
date: 2026-09-01
domain: compiler
permalink: /blog/compiler/constexpr/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/constexpr"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

`constexpr` does not guarantee your code runs at compile time. It guarantees it is allowed to. That distinction matters more than it sounds, and the generated code makes it visible directly.

## Two Fates, One Function

Call a `constexpr` function with an argument the compiler does not know ahead of time, and it runs at runtime like any ordinary function: real instructions, real work, nothing computed in advance. Call the exact same function in a context that requires a compile-time value, and the entire computation is folded into a constant before the program runs. The result shows up baked directly into the binary, no computation remaining.

```cpp
constexpr int square(int n) { return n * n; }

int runtime_call(int x) {
    return square(x);               // x unknown at compile time
}

int compile_time_call() {
    constexpr int result = square(5);   // forced compile-time context
    return result;
}
```

Same function, same source, two different fates, decided entirely by the calling context, not by the `constexpr` keyword on `square` itself.

The disassembly confirms this without ambiguity:

```
runtime_call:
    imul  edi, edi      ; actual multiply instruction at runtime
    mov   eax, edi
    ret

compile_time_call:
    mov   eax, 0x19     ; 25 in hex, loaded directly, no multiply anywhere
    ret
```

`0x19` is 25. The entire multiplication is gone from `compile_time_call`. It was done at compile time and the result was written into the binary. `runtime_call` has the `imul` because the compiler had no choice: `x` is only known when the function is actually called.

## How to Confirm Compile-Time Evaluation

Three methods, each with different properties:

**`constexpr` variable**: declaring the result as `constexpr` forces compile-time evaluation. If the function cannot produce a constant expression with the given arguments, the declaration fails to compile rather than silently falling back to runtime.

```cpp
constexpr int result = square(5);   // compile-time or compile error
```

**`static_assert`**: combining both. The `static_assert` only passes if the expression is a constant and its value matches. If the function ran at runtime instead, the assertion fails at compile time.

```cpp
static_assert(square(5) == 25);   // proves the value was known at compile time
```

**Disassembly**: confirms what actually ended up in the binary. A constant expression produces a `mov` with the literal value. A runtime call produces the actual computation instructions. The GitHub code includes both functions and the objdump output confirms which one looks like which.

**Template parameter**: using the result as a template argument forces compile-time evaluation, since template arguments must be constant expressions.

```cpp
std::array<int, square(5)> arr;   // square(5) must be constexpr here
```

## What constexpr Actually Requires of a Function

The requirements on a `constexpr` function have relaxed significantly across standard versions. In C++11, the restrictions were severe: essentially one return statement, no loops, no local variables. C++14 removed most of those restrictions, allowing loops, multiple statements, and local variables. C++17 added `if constexpr` (a compile-time branch, distinct from `constexpr if` on a regular function) and constexpr lambdas. C++20 extended it further, as covered below.

The core requirement across all versions: when called with compile-time arguments, the function must be evaluable by the compiler's constant evaluator. This means it cannot call functions that are not themselves constexpr, cannot access runtime state, and cannot produce undefined behavior (the compiler detects and rejects undefined behavior at compile time in a constexpr context, which is stricter than runtime where UB is silent).

One consequence: a `constexpr` function must be evaluable for every set of compile-time arguments it might receive. If the function has a branch that would be undefined behavior for a particular input, that branch will cause a compile error for that input, not undefined behavior at runtime.

## C++20: The Heap at Compile Time

C++20 extends `constexpr` to cover heap allocation and heap-allocating containers. `std::vector` and `std::string` can be created, used, and destroyed inside a `constexpr` function. This works through a mechanism called transient allocation: the compiler's constant evaluator tracks heap allocations made during compile-time evaluation and verifies they are fully released before the evaluation completes.

```cpp
constexpr int sum_via_vector(int n) {
    std::vector<int> v;
    for (int i = 0; i < n; i++) v.push_back(i);
    int total = 0;
    for (int x : v) total += x;
    return total;
}

static_assert(sum_via_vector(5) == 10);   // vector allocated and freed entirely at compile time
```

The `static_assert` passes: the vector is constructed, populated, read, and destroyed entirely during compile-time evaluation, and only the final `int` survives into the binary. No heap allocation appears at runtime. The intermediate vector existed only in the compiler's evaluator.

## The Restriction That Makes It Work

The rule is precise: any heap allocation made during a `constexpr` evaluation must be fully released before that evaluation completes. Returning the allocated container from the function and keeping it alive as a `constexpr` variable is not allowed.

```cpp
constexpr std::vector<int> make_vector(int n) {
    std::vector<int> v;
    for (int i = 0; i < n; i++) v.push_back(i);
    return v;   // trying to keep heap allocation alive past compile time
}

constexpr std::vector<int> result = make_vector(5);   // compile error
```

The compiler refuses with an error pointing at the specific `operator new` call whose allocation was still alive when `make_vector` returned. The error is precise rather than vague, which is intentional: the standard requires the compiler to report which allocation caused the rejection.

The reason for the restriction is fundamental. A `constexpr` variable must have its value fully determined at compile time and embedded in the binary. A `std::vector` is a pointer to heap-allocated memory. At compile time there is no persistent heap: the compiler's constant evaluator runs in a scratch space that does not map to any runtime address. A pointer into that scratch space cannot mean anything at runtime, because the memory it points to will not exist.

The rule that allocations must be transient is what allows heap use at compile time at all. Without it, there would be no safe subset to permit.

## std::is_constant_evaluated(): the Function That Knows Where It Is

Most explanations treat the compile-time versus runtime decision as something that happens to a constexpr function from the outside. `std::is_constant_evaluated()` (C++20) inverts that: the function itself can detect which context it is running in and branch accordingly.

```cpp
#include <cmath>
#include <type_traits>

constexpr double safe_pow(double base, int exp) {
    if (std::is_constant_evaluated()) {
        // simple loop: constexpr-safe, no std::pow dependency
        double result = 1.0;
        for (int i = 0; i < exp; i++) result *= base;
        return result;
    } else {
        return std::pow(base, exp);   // fast runtime path, not constexpr-required
    }
}
```

At compile time, the `if (std::is_constant_evaluated())` branch is taken and the loop runs inside the compiler's constant evaluator, producing a folded constant. At runtime, the `std::pow` path runs instead, using the hardware-optimized math library function. The call site syntax is identical in both cases.

The practical value is that the two paths can have different requirements. `std::pow` is not constexpr and cannot appear in the compile-time branch at all. The loop is slow compared to `std::pow` at runtime but that does not matter in the compile-time path since the result gets folded anyway. `std::is_constant_evaluated()` lets you write one function that is correct and efficient in both contexts without any compromise in either direction.

One important rule: `std::is_constant_evaluated()` must always be used as the condition of a plain `if` statement, never inside `if constexpr`. The latter is a well-documented footgun: `if constexpr`'s condition is itself evaluated in a constant expression context, which means `std::is_constant_evaluated()` inside it always returns `true` regardless of how the outer function is actually being called. The branching pattern silently breaks and the runtime path is never taken. Plain `if` is the only correct form.

Storing the result in a `bool` and then checking the `bool` also defeats the mechanism, for the same reason: the compiler can only make the compile-time vs runtime decision when the call appears directly as the condition.

Since C++23, `if consteval` provides a cleaner syntax that was added specifically to eliminate this footgun:

```cpp
constexpr double safe_pow(double base, int exp) {
    if consteval {
        double result = 1.0;
        for (int i = 0; i < exp; i++) result *= base;
        return result;
    } else {
        return std::pow(base, exp);
    }
}
```

`if consteval` is not a condition that evaluates to true or false at runtime. It is a compile-time branch selection that never generates a branch instruction. More importantly, it has no `std::is_constant_evaluated()` call to misuse: the `if constexpr` footgun cannot happen because there is no expression to accidentally evaluate in the wrong context.

## Compile-Time UB Detection

When a constexpr function is evaluated in a constant expression context, the compiler's constant evaluator is stricter than the runtime about undefined behavior. UB that would be silent at runtime is a compile error in a constexpr context.

```cpp
constexpr int overflow(int x) {
    return x + 2147483647;   // signed integer overflow: UB
}

// runtime: silent UB, result is implementation-defined
int a = overflow(1);

// compile time: compile error, UB detected
constexpr int b = overflow(1);   // error: overflow in constant expression
```

The same applies to out-of-bounds array access, null pointer dereference, and other forms of UB that the evaluator can detect. At runtime these produce undefined behavior with no diagnostic. In a constexpr context they are caught at compile time with an error pointing at the specific operation responsible.

This makes forcing compile-time evaluation useful as a debugging technique, not just a performance one. If you have a constexpr function you want to audit for UB on a specific set of inputs, wrapping those calls in a `static_assert` or assigning to a `constexpr` variable runs them through the compiler's UB detector without shipping any instrumentation to production. The check exists only during compilation and costs nothing at runtime.

```cpp
constexpr int risky(int x, int y) {
    return x / y;   // UB if y == 0
}

// audit specific inputs at compile time, zero runtime cost
static_assert(risky(10, 2) == 5);   // fine
constexpr int bad = risky(10, 0);   // compile error: division by zero
```

The constraint is that the evaluator only catches UB it can observe directly. If UB is hidden behind a pointer cast or a reinterpret, the evaluator may not detect it. But for the common cases: overflow, out-of-bounds, division by zero, null dereference, it is more reliable than any runtime sanitizer at catching the specific inputs you test against.

## Run: codegen.cpp

```bash
g++ -O2 -std=c++20 -c codegen.cpp -o codegen.o
objdump -d -M intel --no-show-raw-insn codegen.o
```

`-c` compiles to an object file without linking. Expect `runtime_call` to contain an actual `imul` instruction and `compile_time_call` to contain only a `mov` loading `0x19` (25), no multiply anywhere.

## Run: main.cpp

```bash
g++ -O2 -std=c++20 main.cpp -o main && ./main
```

The `static_assert` in this file only compiles if `sum_via_vector(5)` evaluates to `10` at compile time. If it ran at runtime instead, the assert fails to compile rather than silently producing the wrong behavior. Expect the build to succeed and the program to print the result.

## Run: fail.cpp

```bash
g++ -O2 -std=c++20 -c fail.cpp -o fail.o
```

This is expected to fail. The compiler should name the specific `operator new` call whose allocation survives past the function return as the reason the expression cannot be a constant expression.

## Output

```
$ ./main
sum_via_vector(5) = 10
```

```
$ objdump -d -M intel --no-show-raw-insn codegen.o

0000000000000000 <runtime_call(int)>:
   0:   imul   edi,edi
   3:   mov    eax,edi
   5:   ret

0000000000000010 <compile_time_call()>:
  10:   mov    eax,0x19
  15:   ret
```

`runtime_call` has `imul`, the multiply runs when the program runs. `compile_time_call` is two instructions: `mov eax, 0x19` loads 25 directly, the entire computation was done before this code ever executed.

```
$ g++ -O2 -std=c++20 -c fail.cpp -o fail.o
fail.cpp: In function 'int main()':
fail.cpp:20:54: error: 'make_vector(5)' is not a constant expression because it refers to a result of 'operator new'
   20 |     constexpr std::vector<int> result = make_vector(5);
      |                                                      ^
In file included from .../include/c++/16.1.0/vector:65,
                 from fail.cpp:1:
.../include/c++/16.1.0/bits/allocator.h:203:52: note: allocated here
  203 |             return static_cast<_Tp*>(::operator new(__n));
      |                                      ~~~~~~~~~~~~~~^~~~~
```

The compiler points at the exact `operator new` call responsible. The C++20 rule is enforced with a precise diagnostic, not a vague rejection.



## Run: codegen.cpp

```bash
g++ -O2 -std=c++20 -c codegen.cpp -o codegen.o
objdump -d -M intel --no-show-raw-insn codegen.o
```

`-c` compiles to an object file without linking. Expect `runtime_call` to contain an actual `imul` instruction and `compile_time_call` to contain only a `mov` loading `0x19` (25), no multiply anywhere.

## Run: main.cpp

```bash
g++ -O2 -std=c++20 main.cpp -o main && ./main
```

The `static_assert` in this file only compiles if `sum_via_vector(5)` evaluates to `10` at compile time. If it ran at runtime instead, the assert fails to compile rather than silently producing the wrong behavior. Expect the build to succeed and the program to print the result.

## Run: fail.cpp

```bash
g++ -O2 -std=c++20 -c fail.cpp -o fail.o
```

This is expected to fail. The compiler should name the specific `operator new` call whose allocation survives past the function return as the reason the expression cannot be a constant expression.

## Output

```
$ ./main
sum_via_vector(5) = 10
```

```
$ objdump -d -M intel --no-show-raw-insn codegen.o

0000000000000000 <runtime_call(int)>:
   0:   imul   edi,edi
   3:   mov    eax,edi
   5:   ret

0000000000000010 <compile_time_call()>:
  10:   mov    eax,0x19
  15:   ret
```

`runtime_call` has `imul`, the multiply runs when the program runs. `compile_time_call` is two instructions: `mov eax, 0x19` loads 25 directly, the entire computation was done before this code ever executed.

```
$ g++ -O2 -std=c++20 -c fail.cpp -o fail.o
fail.cpp: In function 'int main()':
fail.cpp:20:54: error: 'make_vector(5)' is not a constant expression because it refers to a result of 'operator new'
   20 |     constexpr std::vector<int> result = make_vector(5);
      |                                                      ^
In file included from .../include/c++/16.1.0/vector:65,
                 from fail.cpp:1:
.../include/c++/16.1.0/bits/allocator.h:203:52: note: allocated here
  203 |             return static_cast<_Tp*>(::operator new(__n));
      |                                      ~~~~~~~~~~~~~~^~~~~
```

The compiler points at the exact `operator new` call responsible. The C++20 rule is enforced with a precise diagnostic, not a vague rejection.


## Quick Reference

**Coming from other languages**

Most languages either evaluate constants purely at compile time (with severe restrictions on what can be a constant) or have no distinction between compile-time and runtime computation at all. C++'s `constexpr` is unusual in being context-sensitive: the same function is evaluated at compile time in some call sites and at runtime in others, depending only on whether the arguments are known. This makes `constexpr` more flexible than a strict "compile-time only" system but also means the keyword alone does not guarantee anything about when the computation happens.

**The 90% mental model**

`constexpr` on a function means the function is allowed to run at compile time when called with compile-time arguments. It does not mean it always does. To force compile-time evaluation, the result must be used in a context that requires a constant expression: a `constexpr` variable declaration, a `static_assert`, or a template parameter. The disassembly shows the difference clearly: a compile-time call produces a `mov` with the literal result, a runtime call produces the actual computation instructions. Since C++20, `constexpr` functions can allocate heap memory (via `std::vector`, `std::string`, etc.) as long as all allocations are freed before the function returns. Returning a heap-allocated container as a `constexpr` variable is rejected with a precise error naming the surviving allocation.
