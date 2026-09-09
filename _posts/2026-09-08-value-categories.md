---
layout: post
title: "Value Categories: What Decides Copy vs Move"
date: 2026-09-08
domain: language
permalink: /blog/language/value-categories/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/language/value-categories"
linkedin: "https://www.linkedin.com/posts/activity-7503129044083740673-dJ7A/"
---

The same variable, written twice in the same function, can trigger two different constructors. Nothing about the variable changed. What changed is how it was used, and the mechanism behind that is value categories.

## The Three Primary Categories

Every C++ expression has a value category. Not every value, not every type, every expression at every point of use. The category is determined by how the expression is being used right now, not by what the variable was declared as.

**lvalue** (locator value): an expression that refers to an object with a persistent memory location. Named variables are the canonical case. `a`, `*ptr`, `arr[0]`, all lvalues. You can take their address with `&`. They exist before the current expression and continue to exist after it.

**prvalue** (pure rvalue): an expression that computes a value without necessarily identifying a persistent object. The direct result of a function returning by value is a prvalue. Literal constants are prvalues. An arithmetic expression like `x + 1` is a prvalue. A prvalue has no address you can take. It has no guaranteed persistent location.

**xvalue** (expiring value): an expression that refers to an object whose lifetime is near its end and whose resources are safe to steal. `std::move(a)` is the classic case. The object is real, it has an address, but it has been flagged as expiring. The xvalue borrows the object's identity while marking it as available for resource transfer.

## The Venn Diagram: glvalues and rvalues

The three primary categories form two overlapping groups that the standard names:

**glvalue** (generalized lvalue) = lvalue + xvalue. Anything that has identity, a real object in memory you can locate. glvalues can be bound to lvalue references (with the right cv-qualifiers).

**rvalue** = xvalue + prvalue. Anything that can be moved from or that has no persistent identity. rvalues bind to rvalue references.

The xvalue sits in both groups simultaneously, and this is the insight that makes the taxonomy coherent rather than arbitrary. An xvalue has identity (it is a real object, it has an address, it exists in memory) but it is also movable-from (it is expiring, its resources are available). A prvalue has neither identity nor persistence. An lvalue has identity and persistence, no movability.

```
          glvalue
         /       \
      lvalue    xvalue
                   \
                  rvalue
                   /
               prvalue
```

## The Reference Binding Rules

The value category of an expression determines which overloads it can bind to. This is the mechanism behind copy-versus-move selection.

`T&` (lvalue reference) binds only to lvalues of type T.
`const T&` (const lvalue reference) binds to lvalues and rvalues of type T. This is why passing by const reference works for temporaries.
`T&&` (rvalue reference) binds to rvalues (xvalues and prvalues) of type T.

When overload resolution sees the expression, it checks the value category and picks the overload whose reference parameter can bind to that category. An lvalue expression finds the copy constructor (which takes `const T&`). An xvalue or prvalue finds the move constructor (which takes `T&&`).

```cpp
Widget a;
Widget b = a;              // a is an lvalue → binds to const Widget& → copy constructor
Widget c = std::move(a);   // std::move(a) is an xvalue → binds to Widget&& → move constructor
Widget d = make_widget();  // make_widget() returns a prvalue → Widget&& → or direct construction
```

Same type, same object in the lvalue and xvalue cases, completely different overload selected.

## std::move: Not a Move, Just a Category Change

`std::move` does not move anything. It does not generate any instructions at runtime. It is a cast. Its entire implementation is:

```cpp
template<typename T>
constexpr std::remove_reference_t<T>&& move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);
}
```

A `static_cast` to rvalue reference. That cast changes the value category of the expression from lvalue to xvalue. Nothing else. The actual move, if any, happens when the resulting xvalue is used as an argument or initializer and the move constructor is invoked.

This has a practical consequence: calling `std::move` on something and then not using the result does nothing. And calling it on something small like an `int` or a pointer will trigger the move constructor for that type, which for trivial types is just a copy anyway. The category change only matters when the type's move constructor actually does something different from its copy constructor.

The other practical consequence is the anti-pattern from the RVO/NRVO post: `return std::move(local)` is worse than `return local`. The `return local` form lets the compiler apply NRVO (named return value optimization), constructing the result directly in the caller's storage with no copy or move. `return std::move(local)` changes the expression to an xvalue, which triggers the move constructor and prevents NRVO from applying. The `std::move` costs a constructor call that would not exist without it. See the <a href="{{ site.baseurl }}/blog/compiler/rvo-nrvo/" target="_blank" rel="noopener noreferrer">RVO/NRVO post</a> for the codegen proof.

## Prvalues and C++17 Mandatory Elision

Prvalues have an additional rule that changed in C++17 and is still widely misunderstood.

Before C++17, returning an object by value from a function created a temporary, and the compiler was allowed (but not required) to elide the copy or move into the destination. This was copy elision, an optional optimization.

Since C++17, the rule is more fundamental: **a prvalue is not an object**. It is a recipe for constructing an object. When a prvalue is used to initialize an object, the object is constructed directly from the recipe. No temporary is created elsewhere and then copied or moved. There is nothing to elide because nothing extra was ever built.

The precise standard term is "temporary materialization": a prvalue is only converted into an xvalue (a real, addressable temporary object) when a glvalue is specifically needed, such as when binding the prvalue to a reference or taking its address. In the straightforward case of using a prvalue to initialize a named variable, materialization never happens.

This is why `-fno-elide-constructors` has no effect on the prvalue case:

```cpp
Widget d = make_widget();   // prvalue initializing Widget d
```

`-fno-elide-constructors` disables the older discretionary elision for RVO and NRVO. It cannot disable C++17 mandatory elision because C++17 mandatory elision is not an optimization that could be turned off. The prvalue simply is not an object until it is materialized. Without materialization, there is no copy or move to elide or to force. The output with and without the flag is identical.

## Temporary Materialization: When Prvalues Become xvalues

A prvalue must be materialized into a real object when:

- It is bound to a reference: `const Widget& r = make_widget()` materializes the prvalue into a temporary that the reference extends.
- Its address is taken: `&make_widget()` would be an error because you cannot take the address of an unmaterialized prvalue (compilers reject this).
- It is accessed as a class member or base class object.
- It appears in certain other contexts requiring a glvalue.

After materialization, the prvalue becomes an xvalue, a real object that is also expiring. The move constructor may then fire when that xvalue is used to initialize something else.

Understanding when materialization happens explains why some code works the way it does. `const Widget& r = Widget{}` is valid: the prvalue `Widget{}` materializes into a temporary Widget, and the const lvalue reference extends the temporary's lifetime to the reference's scope. `Widget& r = Widget{}` is not valid: a non-const lvalue reference cannot bind to the xvalue produced by materialization.

## std::forward and Perfect Forwarding

`std::move` unconditionally casts to xvalue. `std::forward` conditionally preserves the original category:

```cpp
template<typename T>
void wrapper(T&& arg) {
    some_function(std::forward<T>(arg));
}
```

If `wrapper` is called with an lvalue, `T` is deduced as `Widget&` and `std::forward<Widget&>(arg)` produces an lvalue. If called with an rvalue, `T` is deduced as `Widget` and `std::forward<Widget>(arg)` produces an xvalue. The wrapped function sees the same category the original caller used.

Without `std::forward`, `arg` inside `wrapper` is always an lvalue (named parameters are always lvalues), and the wrapped function would always see an lvalue regardless of what the caller passed. `std::forward` is the mechanism that makes the category visible through the forwarding layer. This is why it is called perfect forwarding: the value category is forwarded perfectly, not just the type.

## Run: main.cpp

```bash
g++ -O2 -std=c++26 main.cpp -o main
./main
```

Expect `constructed`, `copy constructor`, `move constructor`, `constructed` in that order. One line per constructor call, showing which constructor each of the four initializations triggers.

## Run: with elision explicitly disabled

```bash
g++ -O2 -std=c++26 -fno-elide-constructors main.cpp -o main-noelide
./main-noelide
```

`-fno-elide-constructors` disables discretionary copy elision. Expect byte-for-byte identical output, confirming the prvalue case was never relying on an optimization this flag could disable. The C++17 mandatory rule applies regardless.

## Output

```
$ ./main
constructed
copy constructor
move constructor
constructed

$ ./main-noelide
constructed
copy constructor
move constructor
constructed
```

Both builds produce identical output, confirming the prvalue case (`Widget d = make_widget()`) never called a copy or move constructor in either build. The `-fno-elide-constructors` flag had nothing to disable because the C++17 mandatory rule means no temporary was ever created to elide in the first place.

## Quick Reference

**Coming from other languages**

Most languages do not expose value categories at the source level. Copy versus move is either handled by the runtime (garbage-collected languages, where mutation is always through references), or the language simply copies everything by default with no concept of "expiring" objects. C++ exposes this because it has deterministic destruction and stack-allocated objects with real lifetimes, which makes the distinction between a persistent object and an expiring one both possible and useful to express. The mechanism that makes move semantics work, the ability to steal resources from an object that is about to be destroyed, depends on being able to mark expressions as expiring at the language level, which is what the xvalue category provides.

**The 90% mental model**

An lvalue is a named, persistent object. A prvalue is an unnamed temporary computation that has not been materialized into an object yet. An xvalue is an object that has been marked as expiring, via `std::move` or similar. lvalue expressions bind to `const T&` and trigger the copy constructor. xvalue and prvalue expressions bind to `T&&` and trigger the move constructor. Since C++17, prvalues used to initialize objects are not materialized at all: the destination object is constructed directly from the prvalue, skipping both copy and move entirely. `std::move` does not move anything; it changes the value category of its argument from lvalue to xvalue so that the move constructor becomes eligible. `std::forward` conditionally preserves the original value category through a template layer.
