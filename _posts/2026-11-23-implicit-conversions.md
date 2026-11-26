---
layout: post
title: "Integer Promotion and Implicit Conversions"
date: 2026-11-23
domain: language
permalink: /blog/language/implicit-conversions/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/language/implicit-conversion"
linkedin: "https://www.linkedin.com/posts/activity-7530676884414767105-Iw4e/"
---

Add two `uint8_t` values, 200 and 100, and the result is 300. A `uint8_t` tops out at 255, so where does the 300 fit? In an `int`. The operands never get added as 8-bit values. Operators in C++ work on a small set of types, and a value of any smaller type is converted before the operation runs. Most surprises with integers come from one of three places: the conversion that happens before the operator, the conversion that picks a common type for two different operands, and the conversion that happens when the result is stored.

## Promotion: Anything Smaller than int Becomes int

In C++, arithmetic does not happen on types smaller than `int`. Before the `+` runs, both operands go through integral promotion. If `int` can represent every value of the operand's type, the operand becomes an `int`. That covers `bool`, `char`, `signed char`, `unsigned char`, `short`, `unsigned short`, and so `uint8_t` and `uint16_t`, on any platform where `int` is 32 bits. So `a + b` has type `int`, and 300 fits without trouble.

```cpp
uint8_t a = 200, b = 100;
auto sum = a + b;                       // both promoted to int: 300
uint8_t back = a + b;                   // demoted on store: 300 mod 256 = 44
```

The rule exists because `int` is the width the machine does arithmetic at. On x86-64, compiling a function that returns `a + b` for two `uint8_t` arguments gives one 32-bit `lea` and a `ret`. There is no 8-bit add. The result is only cut to 8 bits if something reads it as 8 bits, which a `uint8_t` return does by using the low byte of the register.

Promotion is not limited to `+`. It applies to the operands of every arithmetic and bitwise operator, to unary `-`, `+` and `~`, and to the left operand of a shift, so the result of each of those has type `int` too. Three consequences are easy to miss.

The promoted type is signed. Two `uint16_t` values of 65535 multiplied together are promoted to `int` first, and 65535 * 65535 is 4,294,836,225, which does not fit in a 32-bit `int`. That is signed overflow, which is undefined behavior, in an expression made entirely of unsigned types. Compiled with `-fsanitize=undefined`, it reports `signed integer overflow: 65535 * 65535 cannot be represented in type 'int'`.

Bitwise not works on the promoted value, so it sets bits that the narrow type does not have:

```cpp
uint8_t a = 0x0F;
auto n = ~a;                            // a promoted to int first: 0xFFFFFFF0, not 0xF0
bool wide = (~a == 0xF0);               // false: compares 0xFFFFFFF0 with 0xF0
bool cut = (uint8_t(~a) == 0xF0);       // true: cast back to 8 bits before comparing
```

`~a` has type `int` and a size of 4 bytes. The comparison to 0xF0 is false because the upper 24 bits are all ones. Storing the result into a `uint8_t` first, or casting it, cuts it back to 0xF0 and the comparison is true.

Plain `char` is promoted by value, and whether it is signed is up to the platform. On x86-64 Linux with GCC it is signed, so a `char` holding the byte 200 promotes to -56, while on a platform where `char` is unsigned it promotes to 200.

`promotion.cpp` checks the promotion rule at compile time. It has `static_assert`s that the sum of two values of each of the five small types is an `int`, so the claim is checked by the compiler instead of by reading output. It then prints the values:

```bash
g++ -std=c++20 -O2 promotion.cpp -o promotion && ./promotion
```

`-O2` is the standard optimization level used across this repo.

```
a + b = 300, type is int: 1
uint8_t back = a + b -> 44
int8_t back_signed = a + b -> 44
-1 becomes 4294967295, so -1 < 1u is false
int t = 3.99 -> 3
```

The sum is 300 and its type is `int`. The same 300 stored into an 8-bit type becomes 44, whether the type is unsigned or signed, since 300 mod 256 is 44. The -1 is converted to 4294967295 before the comparison, so it is not less than 1. The 3.99 loses its fraction.

## Usual Arithmetic Conversions: When the Types Differ

After promotion, if the two operands still have different types, the compiler converts both to a common one. The rules go in order:

1. If both have the same signedness, the narrower converts to the wider.
2. If the unsigned operand has the same or higher rank, the signed operand converts to the unsigned type.
3. Otherwise, if the signed type can represent every value of the unsigned type, the unsigned operand converts to the signed type.
4. Otherwise, both convert to the unsigned version of the signed type.

Put -1 next to an unsigned 1 and both are the same rank, so rule 2 applies and the -1 becomes 4,294,967,295. So `-1 < 1u` is false:

```cpp
int neg = -1;
bool less = neg < 1u;                   // -1 becomes 4294967295: false
```

The result depends on the widths. On x86-64 Linux, `long` is 64 bits and can represent every `unsigned int` value, so rule 3 applies to `-1L < 1u` and the comparison is true. The same source text gives a different answer depending on which operand types are involved.

C++20 added a way out of the question entirely. `std::cmp_less` and its siblings in `<utility>` compare two integers by value, whatever their types, so `std::cmp_less(-1, 1u)` is true.

### Where the Common Type Hides

The same rules run in places that do not look like arithmetic.

Comparisons against -1 depend on the width of the unsigned side:

```cpp
uint8_t  u8  = 255;
uint16_t u16 = 65535;
uint32_t u32 = 4294967295u;

bool a = (u8  == -1);                   // false: u8 promotes to int 255, compared with -1
bool b = (u16 == -1);                   // false: same reason, 65535 against -1
bool c = (u32 == -1);                   // true: -1 converts to unsigned int 4294967295
```

A `uint8_t` and a `uint16_t` are promoted to `int`, so the comparison is between two ints and the values differ. A `uint32_t` is already `unsigned int`, so the -1 is converted and the two match. The same check written for three different widths gives two different answers.

The conditional operator picks a common type for its two result branches, whichever one is chosen at runtime:

```cpp
auto t = true ? -1 : 1u;                // type is unsigned int, t is 4294967295
```

Two branches of the same type, such as two `uint8_t`, keep that type, because the common type is only computed when the types differ.

Subtracting unsigned values stays unsigned. `3u - 5u` is 4294967294, and `v.size() - 1` on an empty vector is 18446744073709551615, not -1. The same thing is behind the classic loop that never ends:

```cpp
for (size_t i = v.size() - 1; i >= 0; --i)   // i >= 0 is always true for an unsigned type
```

Template deduction does not apply the common type at all. `std::max(i, l)` with an `int` and a `long` does not compile, with `deduced conflicting types for parameter 'const _Tp' ('int' and 'long int')`, because each argument deduces its own `T`. Writing `std::max<long>(i, l)` or converting one argument settles it.

## Demotion: The Value Gets Cut Down

Going the other way, a value is converted to the type of the thing it is stored into, and if it does not fit, it is cut down.

Converting to an unsigned type is always defined. The result is the value modulo 2 to the power of the type's width. That is where the 44 comes from: 300 mod 256. Converting an out-of-range value to a signed type was implementation-defined before C++20. From C++20 it is defined the same way, as the value modulo 2 to the power of the width, which is why storing 300 into an `int8_t` also gives 44 here. A value of 200 stored into an `int8_t` gives -56.

Converting a floating-point value to an integer truncates toward zero, so 3.99 becomes 3 and -3.99 becomes -3. If the truncated value does not fit in the destination, the behavior is undefined:

```cpp
double d = 3.99;
int t = d;                              // fraction dropped: 3
```

`floatcast.cpp` converts a `double` of 1e10, which is too big for a 32-bit `int`:

```bash
g++ -std=c++20 -O2 floatcast.cpp -o floatcast && ./floatcast
g++ -std=c++20 -O2 -fsanitize=undefined floatcast.cpp -o floatcast_ubsan && ./floatcast_ubsan
g++ -std=c++20 -O2 -fsanitize=float-cast-overflow floatcast.cpp -o floatcast_san && ./floatcast_san
```

```
int t = 1e+10 -> -2147483648
int t = 1e+10 -> -2147483648
floatcast.cpp:14:13: runtime error: 1e+10 is outside the range of representable values of type 'int'
int t = 1e+10 -> -2147483648
```

The 1e10 is too big for an `int`, so the conversion is undefined behavior, and this build produced -2147483648, the smallest `int`. On x86-64 the conversion compiles to `cvttsd2si` (convert with truncation, scalar double, to signed integer: the `t` means it rounds toward zero, which is what C++ requires), which returns that bit pattern whenever the result does not fit. For a 32-bit destination that pattern is 0x80000000, which the instruction documentation calls the "integer indefinite" value, and a 64-bit destination gets 0x8000000000000000. That is what the hardware does, not something the language promises, and an optimizer is allowed to assume the case never happens. `-fsanitize=undefined` does not report it, and the second line is identical to the plain run. The check has to be asked for by name with `-fsanitize=float-cast-overflow`, which reports the conversion.

## Widening Too Late

The conversion that is easiest to miss is the one that does not happen. The target type of an assignment has no influence on how the right-hand side is computed:

```cpp
int n = 100000;
long long wrong = n * n;                // multiplied as int (overflow), then widened
long long right = (long long)n * n;     // widened first: 10000000000
```

`n * n` is an `int` times an `int`, so the multiplication happens in `int`. 10,000,000,000 does not fit, which is signed overflow and undefined behavior, and only then is the result widened to `long long`. The fix is to widen one operand before the operation, so the usual arithmetic conversions bring the other one along. `(long long)(n * n)` does not help, because the multiplication has already happened by then.

`widening.cpp` runs both side by side. `n` comes from the command line so the compiler cannot fold the product at compile time. It runs once plainly and once with the undefined behavior sanitizer:

```bash
g++ -std=c++20 -O2 widening.cpp -o widening && ./widening
g++ -std=c++20 -O2 -fsanitize=undefined widening.cpp -o widening_san && ./widening_san
```

`-fsanitize=undefined` adds run-time checks for undefined behavior and prints a message when one is hit.

```
wrong = 1410065408
right = 10000000000
widening.cpp:18:25: runtime error: signed integer overflow: 100000 * 100000 cannot be represented in type 'int'
wrong = 1410065408
right = 10000000000
```

The first two lines are the plain run and the next three are the sanitizer run. `wrong` holds 1410065408 because 10,000,000,000 minus two times 4,294,967,296 is 1,410,065,408, the product cut down to 32 bits and then widened. That value is what this build produced, not something the language guarantees, since the overflow is undefined behavior. The sanitizer reports the overflow on the multiplication in `wrong`, and nothing is reported for `right`, where the multiplication is done in `long long`.

## Shifts and Compound Assignment

A shift does not use the common type. Each operand is promoted on its own, and the result has the type of the promoted left operand. So `uint8_t a = 0x80; a << 1` is an `int` with the value 0x100, and the bit that left the 8-bit range is still there until the result is stored:

```cpp
uint8_t a = 0x80;
auto r = a << 1;                        // int, 0x100
uint8_t cut = uint8_t(a << 1);          // 0x00, the top bit is gone only now
```

The type of the right operand plays no part. `a << 1L` is still an `int`. Shifting by a count equal to or greater than the width of the promoted left operand is undefined behavior, so `1 << 32` is not a way to get zero. Since C++20, left shifts on signed types are defined in terms of the value modulo 2 to the power of the width, so `1 << 31` is -2147483648 instead of being a question about the sign bit.

Compound assignment hides a demotion. `x += y` means `x = x + y` with `x` evaluated once, so the addition is done in the promoted type and then cut down to the type of `x`:

```cpp
uint8_t x = 250;
x += 10;                                // 260 cut to 8 bits: x is 4
uint8_t y = 255;
y++;                                    // y is 0

int n = 5;
n *= 2.7;                               // 5 * 2.7 is 13.5 in double, stored as 13
```

The last line is the one that looks wrong in review. The multiplication is done in `double` because 2.7 is a `double`, and the fraction is dropped when the result goes back into the `int`.

## Integer Literals Have Types Too

A literal is not an `int` that is later converted. Its type is the first one in a list that can hold the value, and the list depends on the spelling. A decimal literal with no suffix tries `int`, `long`, `long long`. A hexadecimal literal tries `int`, `unsigned int`, `long`, `unsigned long` and so on, so it can become unsigned where a decimal one cannot:

```cpp
decltype(2147483648)                    // long: does not fit in int
decltype(0x80000000)                    // unsigned int: hex tries unsigned before long
decltype(0xFFFFFFFF)                    // unsigned int
decltype(4294967295)                    // long
decltype(-2147483648)                   // long: the minus is an operator applied to 2147483648
```

That last one is why `INT_MIN` is not defined as `-2147483648` in `<climits>`. The literal 2147483648 does not fit in `int`, so it is a `long`, and negating it gives a `long`. With `0x80000000` the type is `unsigned int`, so `0x80000000 > 0` is true and negating it gives an unsigned value.

## Integer and Floating Point

Converting an integer to a floating-point type can lose precision, even though the range is larger. A `float` has a 24-bit significand, so integers above 2 to the power of 24 are not all representable, and a `double` has 53 bits:

```cpp
int big = 16777217;                     // 2^24 + 1
float f = big;                          // 16777216.0

long long b = 9007199254740993LL;       // 2^53 + 1
double d = b;                           // 9007199254740992.0
```

The conversion rounds to a representable neighbor, so there is no overflow, just a value that is off by one.

The type of an expression is again decided by its operands. `double q = 1 / 2;` divides two ints, gets 0, and stores 0.0. `1 / 2.0` is 0.5. Integer division truncates toward zero, so `-7 / 2` is -3 and `-7 % 2` is -1, and the one quotient that does not fit is `INT_MIN / -1`, which is undefined behavior. The undefined behavior sanitizer reports it as `division of -2147483648 by -1 cannot be represented in type 'int'`.

Converting `float` to `double` is exact, but the digits show it: `0.1f` stored in a `double` is 0.10000000149011612, so `0.1f == 0.1` is false. The `float` was rounded to 24 bits first and the `double` literal to 53.

The most common place this surfaces is a library call with a type chosen by the initial value. `std::accumulate` uses the type of its third argument for the running total:

```cpp
std::vector<double> v{0.5, 0.5, 0.5, 0.5};
auto bad  = std::accumulate(v.begin(), v.end(), 0);     // int accumulator, result is 0
auto good = std::accumulate(v.begin(), v.end(), 0.0);   // double accumulator, result is 2.0
```

With an `int` accumulator, each addition converts the running total back to `int` after adding a `double`, so every 0.5 is dropped.

## Other Types That Promote or Convert

`bool`, `char16_t`, `char32_t`, `wchar_t` and unscoped enumerations promote the same way the small integer types do. `true + true` is an `int` with the value 2, and `u'a' + u'a'` is an `int`. An unscoped enum converts to an integer implicitly, so `Red + 1` is an `int`, while a scoped `enum class` has no implicit conversion and needs a cast. `std::to_underlying` from C++23 does that cast without having to name the underlying type.

Converting to `bool` is not a cut by modulo. Any nonzero integer or non-null pointer becomes `true`, so `bool b = 5;` stores `true`, which prints as 1. A bit-field narrower than `int` is promoted like any other small type, so `bf.a + 0` for an `unsigned a : 3` is an `int` as well.

Plain `char` brings in one more trap. On x86-64 Linux it is signed, so a byte like 0xE9 is -23 as an `int`. The `<cctype>` functions such as `isalpha` take an `int` that must be either `EOF` or a value representable as `unsigned char`, so a negative `char` passed straight in is not valid. Cast to `unsigned char` first: `isalpha(static_cast<unsigned char>(c))`.

Arguments passed through `...` get the default argument promotions, which are the integer promotions plus `float` to `double`. That is why `printf("%f", f)` works for a `float` argument, and why `%d` with a `long` argument reads the wrong width instead of converting.

## Conversion Versus Reinterpreting the Bits

Every conversion above works on the value: it changes the bits to keep the value, or cuts the value to fit the type. Sometimes the goal is the opposite, to keep the bits and change how they are read. The two operations are easy to mix up because both can be written as a cast.

```cpp
float f = 1.0f;
int      value = (int)f;                        // 1: the value, converted
uint32_t bits  = std::bit_cast<uint32_t>(f);    // 0x3F800000: the same 32 bits, read as an integer
```

The conversion produces 1, since 1.0 is the value. The bit pattern of 1.0f in IEEE 754 single precision is 0x3F800000, which is what `std::bit_cast` returns. For -2.5f the pattern is 0xC0200000, and the top bit is the sign.

There are three ways to write the second operation, and only two of them are allowed:

```cpp
uint32_t a = std::bit_cast<uint32_t>(f);        // C++20, constexpr, no undefined behavior

uint32_t b;
std::memcpy(&b, &f, sizeof b);                  // all standards, no undefined behavior

uint32_t c = *reinterpret_cast<uint32_t*>(&f);  // undefined behavior
```

The third one reads a `float` object through a `uint32_t` lvalue, which breaks the strict aliasing rule. GCC warns about it with `dereferencing type-punned pointer will break strict-aliasing rules` at `-Wstrict-aliasing`, and an optimizer is allowed to assume the two types never refer to the same storage, so the result at higher optimization levels is not guaranteed even when a small test happens to print the expected bits. Reading a different member of a `union` than the one last written is also undefined in C++, even though C allows it.

`std::bit_cast` and `std::memcpy` both copy the object representation. `std::bit_cast` additionally checks at compile time that the two types have the same size and are trivially copyable, so `std::bit_cast<uint32_t>(double_value)` is rejected with `no matching function`, and it can be used in `constexpr` code, where `memcpy` cannot. With optimization on, `std::bit_cast<uint32_t>(float)` compiles on x86-64 to a single `movd %xmm0, %eax`, a register move from the floating-point register to the integer one.

The `static_assert` form is useful for pinning down bit-level facts at compile time:

```cpp
constexpr uint32_t bits(float f) { return std::bit_cast<uint32_t>(f); }
static_assert(bits(1.0f) == 0x3F800000u);
```

Between integer types of the same width the two operations agree on the bits and differ only in the name. `std::bit_cast<int>(0xFFFFFFFFu)` is -1, which is the same result as the conversion, because converting to a signed type of the same width keeps the bits on this platform and in C++20.

## What the Compiler Warns About

`warnings.cpp` is not run. It holds one function per case and is compiled with the conversion warnings on, to see which cases the compiler reports:

```bash
g++ -std=c++20 -O2 -Wall -Wextra -Wconversion -Wsign-compare -c warnings.cpp -o warnings.o
```

`-c` compiles to an object file without linking, since this file has no `main`.

```
warnings.cpp: In function ‘int8_t sum_demoted_signed(uint8_t, uint8_t)’:
warnings.cpp:21:26: warning: conversion from ‘int’ to ‘int8_t’ {aka ‘signed char’} may change value [-Wconversion]
   21 |     std::int8_t back = a + b;
      |                        ~~^~~
warnings.cpp: In function ‘uint8_t int_demoted(int)’:
warnings.cpp:26:25: warning: conversion from ‘int’ to ‘uint8_t’ {aka ‘unsigned char’} may change value [-Wconversion]
   26 |     std::uint8_t back = v;
      |                         ^
warnings.cpp: In function ‘bool compare_signed_unsigned(int, unsigned int)’:
warnings.cpp:31:16: warning: comparison of integer expressions of different signedness: ‘int’ and ‘unsigned int’ [-Wsign-compare]
   31 |     return neg < one;
      |            ~~~~^~~~~
warnings.cpp: In function ‘int truncate(double)’:
warnings.cpp:35:13: warning: conversion from ‘double’ to ‘int’ may change value [-Wfloat-conversion]
   35 |     int t = d;
      |             ^
```

Four of the six functions are reported. The `int8_t` demotion, the `int` stored into a `uint8_t`, the signed against unsigned comparison and the double to int are each flagged.

Two are not. Line 16, `std::uint8_t back = a + b` from two `uint8_t` values, is the 300 to 44 case, and it compiles without a warning. Line 40, `long long wrong = n * n`, is the late widening, and it compiles without a warning too. The sanitizer is what catches `n * n`. g++ and clang++ also gave no warning on `uint8_t s = a + b` or on `uint8_t s = ~a`.

## Making the Conversion Explicit

Three standard tools turn an implicit conversion into one the compiler checks or the reader can see:

- Brace initialization forbids narrowing. `std::uint8_t x{a + b};` is ill-formed because the `int` result might not fit, and `std::uint8_t x{200};` is fine because the constant fits. GCC reports the non-constant case as a `-Wnarrowing` warning, so check what your compiler does with it.
- `static_cast` or a functional cast at the point of the conversion says that the cut is intended, as in `uint8_t(~a)`. For widening, put it on the operand, as in `(long long)n * n`, not around the finished expression.
- `std::cmp_less` and the other integer comparison functions from C++20 compare by value, without the signed and unsigned conversion.
- `std::in_range<T>(value)` from C++20 asks whether a value fits in `T` before the cut happens. `std::in_range<uint8_t>(300)` is false and `std::in_range<int>(3000000000u)` is false. It makes the check explicit where a cast would silently apply modulo.
- For floating-point to integer, check the range first, since the out-of-range conversion is undefined behavior. For an accumulator or a deduced type, give the initial value the type you want, as in `0.0` or `0LL`.

## Quick Reference

**Coming from other languages**

Languages with one arbitrary-precision integer type, or with checked arithmetic, never change the meaning of a value at an operator boundary. Here the type of an arithmetic result is decided by the operands alone, through the promotion and common-type rules, and the type of the variable it is stored into plays no part until the store. That is why the same value can be correct in the middle of an expression and wrong after the assignment, and why the width of the multiplication matters more than the width of the variable that receives it.

**The 90% mental model**

Anything smaller than `int` becomes `int` before arithmetic, so `uint8_t + uint8_t` is an `int` and 300 fits. When the operands still differ, both convert to a common type, and a signed value meeting an unsigned one of the same rank becomes unsigned, so `-1 < 1u` is false. Storing a result into a narrower type cuts it modulo 2 to the power of the width, which gives 44 for 300 in a `uint8_t` or an `int8_t`. Float to int drops the fraction, and a float too large for the int is undefined behavior. Widening has to happen on an operand before the operation: `long long x = n * n` multiplies in `int` and overflows, and `(long long)n * n` does not. Bitwise not on a narrow type works on the promoted value, so `~a` for a `uint8_t` of 0x0F is 0xFFFFFFF0, not 0xF0. Shifts promote each side on its own and keep the left type, so `uint8_t(0x80) << 1` is 0x100. Compound assignment such as `x += y` does the arithmetic in the promoted type and cuts it back. Decimal literals that do not fit `int` become `long`, hex ones may become `unsigned`. Subtracting unsigned values never goes negative, `v.size() - 1` on an empty vector is the maximum `size_t`. Integers above 2 to the power of 24 are not all exact in a `float`, and above 2 to the power of 53 in a `double`. The type of the initial value of `std::accumulate` is the type of the sum. A cast changes the value to fit a type, and `std::bit_cast` keeps the bits and changes the type: `(int)1.0f` is 1 and `std::bit_cast<uint32_t>(1.0f)` is 0x3F800000. Reading through `reinterpret_cast` pointers or the wrong union member is undefined. Run code that does arithmetic on mixed or narrow types under the undefined behavior sanitizer, since it reported the `n * n` overflow that no warning in the run above did.
