---
layout: post
title: "constinit: Locks the Start, Not the Value"
date: 2026-09-04
domain: compiler
permalink: /blog/compiler/constinit/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/compiler/constinit"
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

A variable can be guaranteed to start life with a compile-time value and still be completely mutable afterward. Those are two separate promises, and `constinit` only makes one of them.

## What constinit Actually Guarantees

`constinit`, introduced in C++20, applies only to variables with static or thread-local storage duration. Local variables, regardless of their initializer, are rejected outright:

```cpp
void foo() {
    constinit int local = 69;   // error: constinit can only be applied to
                                 // a variable with static or thread storage duration
}
```

The error is about storage duration, not about the initializer. The compiler does not even look at the initializer before rejecting this. `constinit` is not a property of a value, it is a property of how a variable's lifetime relates to the program's lifetime.

For variables where it does apply, the guarantee is narrow: the initial value must come from a compile-time constant expression. No dynamic initialization, no depending on a function call that only resolves at runtime. The initializer must be evaluable before the program starts:

```cpp
int get_runtime_value() { return 69; }          // not constexpr
constexpr int get_compile_time_value() { return 69; }

constinit int bad  = get_runtime_value();        // fails to compile
constinit int good = get_compile_time_value();   // compiles fine
```

What `constinit` deliberately does not guarantee is immutability. After the initial value is locked in, the variable is a regular writable variable:

```cpp
int main() {
    good = 100;   // completely legal, constinit only locks the start
}
```

This is a different promise than `const` or `constexpr`, both of which make the value unchangeable for its entire lifetime. `constinit` makes no promise about what happens after initialization.

## The Initialization Priority System

The C++ standard defines initialization for static storage duration variables in three phases, in this order:

1. **Zero-initialization**: every static variable starts here. Integer types get 0, pointer types get null, class types get all members zero-initialized.
2. **Constant initialization**: variables whose initializer is a constant expression get their value set here, before any code runs. This is the earliest and highest-priority phase of user-visible initialization.
3. **Dynamic initialization**: everything else. Constructors run, function calls happen, results from other global variables are used. This is where initialization order dependencies between translation units live.

`constinit` forces a variable into phase 2, constant initialization. It is a compile-time assertion that the variable's initialization does not depend on anything that would push it into phase 3. If the compiler cannot confirm this, the build fails.

This distinction matters because constant initialization is guaranteed to happen before any dynamic initialization. A variable that is constant-initialized has its value set before any constructor in the program runs. A variable that is dynamically initialized depends on the compiler and linker deciding when to run its constructor relative to other translation units, with no cross-file ordering guarantee.

## The Initialization Order Problem it Solves

The <a href="{{ site.baseurl }}/blog/language/before-main/#global-constructors-and-the-static-initialization-order-fiasco" target="_blank" rel="noopener noreferrer">before-main post</a> covered the Static Initialization Order Fiasco (SIOF): a global variable in one file depending on a global variable in another file already being constructed, with no guarantee that ordering holds across translation units. The fix shown there was the function-local static pattern. `constinit` is a different fix for a specific subset of the problem.

If a global variable's starting value depends only on compile-time constants rather than on any other global's constructor having already run, there is no ordering dependency to worry about. `constinit` expresses that intent and enforces it. The compiler verifies that no dynamic initialization is needed and rejects anything that would introduce a hidden cross-file ordering dependency.

```cpp
// file_a.cpp
constinit int base_value = 100;   // constant-initialized, phase 2, always safe

// file_b.cpp
extern int base_value;
constinit int derived = base_value * 2;  // error: base_value is not a constexpr,
                                          // so this is dynamic initialization
```

`derived` cannot be `constinit` because reading `base_value` at initialization time is dynamic initialization, even though `base_value` itself is `constinit`. `constinit` propagates only as far as the actual compile-time constant value, not through runtime reads of other `constinit` variables.

## constinit on Thread-Local Variables

`constinit` also applies to `thread_local` variables. Each thread gets its own copy of a thread-local variable, and `constinit` guarantees that each copy starts from a compile-time constant before the thread begins executing. Without `constinit`, a `thread_local` variable with a dynamic initializer might have a different initialization order relative to other per-thread setup depending on the implementation.

```cpp
thread_local constinit int per_thread_counter = 0;   // each thread starts at 0, guaranteed
```

The mutation guarantee applies here too: the per-thread copy can be modified freely after initialization.

## constinit vs const vs constexpr for Globals

Each of the three makes a different promise for a global variable:

`const int x = f()`: `x` cannot be modified after initialization, but `f()` can be any function. The initialization might be dynamic if `f()` is not constexpr. You get immutability but no compile-time guarantee.

`constexpr int x = f()`: `x` cannot be modified, and `f()` must be a `constexpr` function callable with no arguments as a constant expression. You get both immutability and compile-time initialization.

`constinit int x = f()`: `x` can be modified, and `f()` must produce a compile-time constant. You get compile-time initialization without immutability.

The comparison post following this one covers all four const-family keywords side by side. The short version here: if you want a global that starts from a known compile-time value but needs to be updated at runtime, `constinit` is the right tool. Neither `const` nor `constexpr` permit modification after initialization.

## constinit on extern Declarations

Most explanations of `constinit` only show it on definitions. It can also appear on `extern` declarations, which is where it becomes useful as part of a library contract.

Placing `constinit` on an `extern` declaration in a header expresses a promise: whoever provides the definition must give it a constant initializer. The constraint is visible at the point of declaration, not buried in an implementation file the header's users may never read.

```cpp
// public_api.h
extern constinit int error_code;   // promise: this will be constant-initialized

// implementation.cpp
constinit int error_code = 0;      // satisfies the promise

// bad_implementation.cpp (hypothetical)
int error_code = compute_default(); // violates the constinit on the declaration
                                    // build fails
```

If the definition does not satisfy the `constinit` promise, the build fails at the definition site. This makes SIOF-free initialization enforceable across a large codebase without requiring the definition to live in a header. Any reader of the header sees the guarantee at the `extern` line and knows the variable will never have a dynamic initialization dependency, regardless of which translation unit provides the definition.

## constinit with User-Defined Types

`constinit` does not require the variable's type to be a literal type. The destructor does not need to be trivial. The only requirement is that the constructor used for initialization is `constexpr` and the initializer arguments are constant expressions. A type with cleanup logic in its destructor can still be `constinit`:

```cpp
struct Config {
    constexpr Config(int v) : value(v) {}
    ~Config() { /* non-trivial cleanup */ }   // fine, constinit has no restriction on destructors
    int value;
};

constinit Config cfg(69);   // constant-initialized, freely mutable afterward
cfg.value = 100;            // legal
```

This matters for the use case `constinit` is actually built for. A global configuration object or resource counter that needs to be mutable but must start from a known compile-time value, without depending on any other global's constructor having run first, is a natural fit. The type having a non-trivial destructor does not disqualify it.

The constraint is only on initialization: the constructor must be `constexpr` and the arguments must be constant expressions. Everything that happens after initialization, mutation, destruction, is outside `constinit`'s scope entirely.

## Run: fail.cpp

```bash
g++ -O2 -std=c++26 -c fail.cpp -o fail.o
```

Expected to fail. Expect two errors on `bad`: one naming the variable as lacking a constant initializer, one naming the specific function call responsible.

## Run: main.cpp

```bash
g++ -O2 -std=c++26 main.cpp -o main && ./main
```

Expect the program to print `69` first, then `100`, confirming the compile-time-resolved starting value and the legal mutation afterward.

## Run: fail_storage.cpp

```bash
g++ -O2 -std=c++26 -c fail_storage.cpp -o fail_storage.o
```

Expected to fail. Expect an error naming the storage duration restriction directly. The initializer is never checked.

## Output

```
$ g++ -O2 -std=c++26 -c fail.cpp -o fail.o
fail.cpp:14:15: error: 'constinit' variable 'bad' does not have a constant initializer
   14 | constinit int bad  = get_runtime_value();
      |               ^~~
fail.cpp:14:39: error: call to non-'constexpr' function 'int get_runtime_value()'
   14 | constinit int bad  = get_runtime_value();
      |                      ~~~~~~~~~~~~~~~~~^~
fail.cpp:11:5: note: 'int get_runtime_value()' declared here
   11 | int get_runtime_value() { return 69; }
      |     ^~~~~~~~~~~~~~~~~
```

Two errors plus a note. The first names the variable, the second names the specific non-constexpr call, and the note points back at the function's own declaration.

```
$ g++ -O2 -std=c++26 main.cpp -o main && ./main
before: 69
after: 100
```

Starts at 69, the compile-time-resolved value, then mutates to 100 with no complaint.

```
$ g++ -O2 -std=c++26 -c fail_storage.cpp -o fail_storage.o
fail_storage.cpp: In function 'void foo()':
fail_storage.cpp:12:19: error: 'constinit' can only be applied to a variable with static or thread storage duration
   12 |     constinit int local = get_value();
      |                   ^~~~~
```

A single direct error about storage duration. The initializer is never examined.

## Quick Reference

**Coming from other languages**

Most languages either have no mutable global state at all, or have global state that is always dynamically initialized with no compile-time guarantee. The initialization order problem `constinit` addresses is specific to C++ because C++ allows both compile-time and runtime initialization of globals, creates no ordering guarantee for dynamic initialization across translation units, and lets globals with complex types (including user-defined constructors) live at global scope. Languages that restrict global state to simple types or to compile-time constants avoid the problem by construction but are more constrained in what can be expressed at global scope.

**The 90% mental model**

`constinit` guarantees that a static or thread-local variable's initial value is resolved at compile time, before the program runs. It does not guarantee immutability: the variable can be freely modified after initialization. The practical use is preventing hidden initialization order dependencies between translation units: a `constinit` global does not depend on any other global's constructor having already run, so there is nothing for it to race against at startup. The initializer must come from a compile-time constant expression; anything requiring a runtime function call is rejected with an error naming the specific call responsible.
