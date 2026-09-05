---
layout: post
title: "const, constexpr, consteval, constinit: Four Keywords, Four Different Promises"
date: 2026-09-05
domain: language
permalink: /blog/language/const-comparison/
linkedin: "https://linkedin.com/in/SaitwadekarValay"
---

Four keywords that all start with `const`, introduced across three different standard versions, each making a genuinely different promise. The names suggest they are variations on a theme. The semantics say otherwise.

## The Full Comparison

| | `const` | `constexpr` | `consteval` | `constinit` |
|---|---|---|---|---|
| Introduced | C++03 (C++11 for member functions) | C++11 | C++20 | C++20 |
| Applies to | variables, member functions | variables, functions, constructors, destructors | functions only | static / thread_local variables only |
| Compile-time guarantee | none | optional | mandatory, no runtime version | initialization only |
| Immutability | ✓ | ✓ (for variables) | — | ✗ |
| Runtime version exists | ✓ | ✓ | ✗ | ✓ |
| Implicitly inline | ✗ | ✓ (functions) | ✓ | ✗ |
| Mutually exclusive with | — | `constinit` (on variables) | — | `constexpr` (on variables) |

The mutual exclusivity between `constinit` and `constexpr` is worth calling out specifically because it surprises people. Both apply to variables and both deal with compile-time values, so combining them feels natural. It is not allowed. A `constexpr` variable is already guaranteed to have a compile-time value and is immutable, making `constinit` redundant and contradictory (constinit implies mutability, constexpr implies the opposite). The compiler rejects the combination directly.

## What Each Keyword Actually Promises

**`const`** promises one thing: the value will not change after it is set. The initial value can come from anywhere, including something only known at runtime.

```cpp
const int x = rand();   // perfectly valid, runtime value, immutable afterward
```

This is the most common source of confusion about the four keywords. `const` does not imply compile-time. It never did. A `const` local variable initialized from a function call is evaluated at runtime and pinned. The constness is about mutability, not about when the value is computed.

**`constexpr`** on a variable implies `const`: every `constexpr` variable is immutable, and the initializer must be a constant expression. You would never write `const constexpr int x = 5` because the `const` is redundant. On a function, `constexpr` makes the function eligible for compile-time evaluation when called with constant arguments, while leaving a runtime path available when the arguments are not constant. The same function, two possible fates, determined by calling context.

**`consteval`** removes the runtime path entirely. There is no fallback. A call with a non-constant argument is a compile error, not a performance regression. The function produces no object code, has no address, and cannot be stored in a function pointer.

**`constinit`** makes no promise about immutability. It guarantees that the initialization of a static or thread-local variable happens at compile time, nothing more. After initialization, the variable is freely mutable. It is also mutually exclusive with `constexpr` on variables for the reason above.

## What the Table Does Not Capture

Several things from the individual posts do not compress into a table row without losing their meaning.

**`constexpr` catches undefined behavior at compile time.** When a `constexpr` function is called in a constant expression context, the compiler's evaluator detects UB that would be silent at runtime: signed integer overflow, out-of-bounds array access, null pointer dereference. A `static_assert` wrapping a `constexpr` call is a zero-cost UB audit for specific inputs. The check exists only at build time and costs nothing in the binary. See the <a href="{{ site.baseurl }}/blog/compiler/constexpr/#compile-time-ub-detection" target="_blank" rel="noopener noreferrer">constexpr post's UB detection section</a> for the worked example.

**`if constexpr` in templates discards the untaken branch from compilation entirely.** This is a distinct feature from a `constexpr` function, but it lives under the same keyword. Inside a template, `if constexpr (condition)` evaluates the condition at compile time and removes the untaken branch before the compiler checks it for validity. Code that would be ill-formed for a particular type never gets instantiated as long as it is only reachable through the branch that does not apply for that type. This cannot be done with a plain `if`, where both branches must be valid for every instantiation.

```cpp
template <typename T>
void process(T val) {
    if constexpr (std::is_integral_v<T>) {
        // only compiled when T is an integer type
        val++;
    } else {
        // only compiled when T is not an integer type
        // can reference things that don't exist for integers
    }
}
```

**`std::vector` and `std::string` are usable inside `constexpr` functions since C++20**, with the transient-allocation restriction: any heap allocation made during compile-time evaluation must be fully released before the function returns. Build a vector, compute a result, return the result. The vector existed only in the compiler's evaluator. See the <a href="{{ site.baseurl }}/blog/compiler/constexpr/#c20-the-heap-at-compile-time" target="_blank" rel="noopener noreferrer">constexpr post's C++20 section</a> for the full explanation and the error that fires when the restriction is violated.

**`constinit` on an `extern` declaration makes compile-time initialization part of a library contract.** The definition elsewhere must satisfy the constraint or the build fails at the definition site. This is how you enforce SIOF-free initialization across a codebase without requiring the definition to be in a header. See the <a href="{{ site.baseurl }}/blog/compiler/constinit/#constinit-on-extern-declarations" target="_blank" rel="noopener noreferrer">constinit post's extern section</a>.

**`std::is_constant_evaluated()` lets a `constexpr` function detect its own evaluation context** and branch differently at compile time versus runtime. The one trap: using it inside `if constexpr` instead of plain `if` causes it to always return true, silently breaking the branching pattern. `if consteval` in C++23 was added specifically to eliminate that footgun. See the <a href="{{ site.baseurl }}/blog/compiler/constexpr/#stdis_constant_evaluated-the-function-that-knows-where-it-is" target="_blank" rel="noopener noreferrer">constexpr post's is_constant_evaluated section</a>.

## Decision Guide

**You want a value that cannot change, and you do not care when it is computed:**
Use `const`. The initializer can be a runtime expression.

**You want a value that cannot change, and you want the compiler to compute it at compile time when possible:**
Use `constexpr` on the variable. The initializer must be a constant expression, and the value is immutable.

**You have a function that should only ever run at compile time, and a runtime call should be a build error:**
Use `consteval`. There is no runtime version.

**You want a global or thread-local variable whose starting value is guaranteed to exist at compile time, but the value should be mutable afterward:**
Use `constinit`. The variable starts from a constant expression and is freely modifiable after that.

**You are inside a template and want to branch on a type property with the untaken branch removed from compilation:**
Use `if constexpr`. This is not the same as a `constexpr` function; it is a compile-time conditional inside a template.

## Common Mixing Mistakes

**Assuming `const` implies compile-time**: it does not. `const int x = rand()` is valid C++. The value is runtime-determined and then locked.

**Assuming a `constexpr` function always runs at compile time**: it does not. Call it with a runtime argument and it runs at runtime, silently. Use `static_assert` or a `constexpr` variable declaration to force and verify compile-time evaluation.

**Marking a local variable `constinit`**: rejected immediately, before the initializer is even checked. `constinit` is for static and thread-local storage only.

**Trying to combine `constexpr` and `constinit` on a variable**: rejected. `constexpr` implies compile-time init and immutability. `constinit` implies compile-time init and mutability. The two are contradictory on the immutability axis and the compiler refuses the combination.

**Using a `constinit` variable where a constant expression is required**: `constinit` does not make a variable a constant expression. Using it as an array size or template argument is a compile error even though the variable was initialized at compile time. For those uses, `constexpr` is the right keyword.

**Using `if constexpr (std::is_constant_evaluated())`**: the `if constexpr` evaluates its condition in a constant expression context, so `std::is_constant_evaluated()` inside it always returns true. The runtime branch is silently dead. Use plain `if (std::is_constant_evaluated())` instead, or `if consteval` in C++23.

## The Subsumption Picture

Not all four are peers. Some subsume others in specific contexts:

Every `constexpr` variable is implicitly `const`. You never need to write `const constexpr`.

Every `consteval` function is a stricter version of a `constexpr` function. If you can make something `consteval`, it is also trivially `constexpr`-able, but the reverse is not true.

`constinit` is the only keyword of the four that neither implies immutability nor can appear on functions. It stands apart from the other three in what it addresses: initialization order, not value semantics or computation timing in general.

## Quick Reference

**Coming from other languages**

Most languages collapse this design space into fewer distinctions. A compile-time constant is typically immutable and always compile-time, with no `constinit`-style "start constant, mutate later" option and no `constexpr`-style "sometimes compile time, sometimes not" flexibility. C++ exposes the full lattice because it evolved these keywords incrementally across standards, each one addressing a specific gap the previous ones left open. The result is four overlapping promises that are individually coherent but require understanding the differences to use correctly.

**The 90% mental model**

`const` locks a value after it is set, says nothing about when it is computed. `constexpr` on a variable locks the value and requires a compile-time initializer. `constexpr` on a function permits compile-time evaluation when the context allows, with a runtime fallback when it does not. `consteval` removes the runtime fallback entirely: compile-time or build error. `constinit` requires the initializer to be a compile-time constant expression but does not lock the value afterward: freely mutable, no immutability guarantee. `constexpr` and `constinit` cannot appear together on the same variable. `constexpr` functions are implicitly inline. `consteval` functions produce no runtime code and have no address. `if constexpr` inside a template discards the untaken branch from compilation entirely, which is distinct from a `constexpr` function.
