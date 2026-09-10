---
layout: post
title: "new, operator new, Placement new, and malloc: Allocation vs Construction"
date: 2026-09-09
domain: memory
permalink: /blog/memory/allocation-vs-construction/
github: "https://github.com/Valay17/Cpp-Journal/tree/main/memory/allocation-vs-construction"
linkedin: "https://www.linkedin.com/posts/activity-7503482644052037632-v39W/"
---

There are four ways to get memory in C++, and most people only ever use one. Then they write a custom allocator or a memory pool, and the difference between "allocate" and "construct" becomes the entire problem.

## The Four Mechanisms

<div style="background:#0D1117;border-radius:8px;padding:20px;margin:20px 0;">
<svg viewBox="0 0 900 400" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  <!-- new T() top box -->
  <rect x="310" y="20" width="280" height="70" rx="6" fill="#58A6FF15" stroke="#58A6FF" stroke-width="1.5"/>
  <text x="450" y="42" font-family="sans-serif" font-size="11" font-weight="700" fill="#E6EDF3" text-anchor="middle">new</text>
  <text x="450" y="57" font-family="monospace" font-size="11" fill="#58A6FF" text-anchor="middle">new T(args)</text>
  <text x="450" y="72" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">allocate + construct · T* · throws bad_alloc · delete p</text>

  <!-- Branch lines from new down -->
  <line x1="450" y1="90" x2="450" y2="115" stroke="#444C56" stroke-width="1.5"/>
  <line x1="250" y1="115" x2="650" y2="115" stroke="#444C56" stroke-width="1.5"/>
  <line x1="250" y1="115" x2="250" y2="140" stroke="#444C56" stroke-width="1.5"/>
  <line x1="650" y1="115" x2="650" y2="140" stroke="#444C56" stroke-width="1.5"/>

  <!-- Allocate label -->
  <text x="250" y="135" font-family="sans-serif" font-size="10" fill="#58A6FF" text-anchor="middle" font-weight="600">Allocate</text>

  <!-- Construct label -->
  <text x="650" y="135" font-family="sans-serif" font-size="10" fill="#3FB950" text-anchor="middle" font-weight="600">Construct</text>

  <!-- Allocate splits into two -->
  <line x1="250" y1="140" x2="250" y2="158" stroke="#444C56" stroke-width="1.5"/>
  <line x1="130" y1="158" x2="370" y2="158" stroke="#444C56" stroke-width="1.5"/>
  <line x1="130" y1="158" x2="130" y2="178" stroke="#444C56" stroke-width="1.5"/>
  <line x1="370" y1="158" x2="370" y2="178" stroke="#444C56" stroke-width="1.5"/>

  <!-- Construct goes to placement new -->
  <line x1="650" y1="140" x2="650" y2="178" stroke="#444C56" stroke-width="1.5"/>

  <!-- operator new box -->
  <rect x="30" y="178" width="200" height="120" rx="6" fill="#58A6FF0A" stroke="#58A6FF55" stroke-width="1.5"/>
  <text x="130" y="198" font-family="sans-serif" font-size="11" font-weight="700" fill="#E6EDF3" text-anchor="middle">operator new</text>
  <text x="130" y="213" font-family="monospace" font-size="10" fill="#58A6FF" text-anchor="middle">operator new(n)</text>
  <line x1="50" y1="220" x2="210" y2="220" stroke="#21262D" stroke-width="1"/>
  <text x="130" y="234" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">allocate only · void*</text>
  <text x="130" y="248" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">throws bad_alloc</text>
  <text x="130" y="262" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">no header (nothrow: &lt;new&gt;)</text>
  <text x="130" y="276" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">operator delete(p)</text>

  <!-- malloc box -->
  <rect x="270" y="178" width="200" height="120" rx="6" fill="#E8845A0A" stroke="#E8845A55" stroke-width="1.5"/>
  <text x="370" y="198" font-family="sans-serif" font-size="11" font-weight="700" fill="#E6EDF3" text-anchor="middle">malloc</text>
  <text x="370" y="213" font-family="monospace" font-size="10" fill="#E8845A" text-anchor="middle">malloc(size)</text>
  <line x1="290" y1="220" x2="450" y2="220" stroke="#21262D" stroke-width="1"/>
  <text x="370" y="234" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">allocate only · void*</text>
  <text x="370" y="248" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">returns nullptr on fail</text>
  <text x="370" y="262" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">&lt;cstdlib&gt;</text>
  <text x="370" y="276" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">free(p)</text>

  <!-- placement new box -->
  <rect x="510" y="178" width="280" height="120" rx="6" fill="#3FB9500A" stroke="#3FB95055" stroke-width="1.5"/>
  <text x="650" y="198" font-family="sans-serif" font-size="11" font-weight="700" fill="#E6EDF3" text-anchor="middle">placement new</text>
  <text x="650" y="213" font-family="monospace" font-size="10" fill="#3FB950" text-anchor="middle">new (ptr) T(args)</text>
  <line x1="530" y1="220" x2="770" y2="220" stroke="#21262D" stroke-width="1"/>
  <text x="650" y="234" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">construct only · T*</text>
  <text x="650" y="248" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">uses existing memory · &lt;new&gt;</text>
  <text x="650" y="262" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">no allocation happens</text>
  <text x="650" y="276" font-family="sans-serif" font-size="10" fill="#8B949E" text-anchor="middle">p-&gt;~T() only, never delete</text>

  <!-- internal note -->
  <text x="450" y="345" font-family="sans-serif" font-size="10" fill="#444C56" text-anchor="middle">new uses operator new internally for its allocation step, then constructs via placement new</text>
  <text x="450" y="360" font-family="sans-serif" font-size="10" fill="#444C56" text-anchor="middle">operator new and malloc differ only in C++ vs C origin and how they signal failure</text>

</svg>
</div>

**`new T(args)`**: the only one that does both jobs. Allocates memory by calling `operator new(sizeof(T))` internally, then calls `T`'s constructor on the returned memory. Returns `T*`. Throws `std::bad_alloc` on allocation failure. Freed with `delete`, which calls the destructor then `operator delete`. No header required for plain `new` and `delete`.

**`operator new(size)`**: allocates only. Returns `void*`, raw uninitialized bytes, no constructor runs. Throws `std::bad_alloc` on failure. This is the function `new` calls internally, and it is a real function subject to overloading, not a language keyword. Overloading it per class redirects all `new` expressions for that type to a custom allocator without any change at the call site. Freed with `operator delete`. Also available in a nothrow form: `operator new(size, std::nothrow)` returns `nullptr` instead of throwing.

**Placement new `new (ptr) T(args)`**: constructs only. Takes memory that already exists and builds an object directly inside it. No allocation happens, no memory is reserved. Returns `T*` pointing to the same address as `ptr`. Since nothing was allocated, `delete` cannot be used to clean up. The destructor must be called explicitly: `p->~T()`. Requires `#include <new>`.

**`malloc(size)`**: the C function. Allocates raw bytes, returns `void*`, must be cast. Returns `nullptr` on failure, no exception. No constructor ever runs. Freed with `free`, never `delete`. Requires `#include <cstdlib>`.

```cpp
// allocates AND constructs
Widget* a = new Widget();
delete a;   // destructs AND deallocates

// allocates ONLY
void* raw = operator new(sizeof(Widget));
operator delete(raw);   // deallocates ONLY, no destructor

// constructs ONLY, in existing memory
alignas(Widget) char buffer[sizeof(Widget)];
Widget* p = new (buffer) Widget();
p->~Widget();   // must call destructor explicitly

// raw bytes ONLY, no constructor
Widget* m = static_cast<Widget*>(malloc(sizeof(Widget)));
free(m);   // raw bytes only, no destructor
```


<div style="overflow-x:auto;margin:16px 0;">
<table style="width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
<thead>
<tr style="background:#161B22;border-bottom:2px solid #30363D;">
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Name</th>
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Syntax</th>
<th style="padding:10px 12px;text-align:center;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Allocates</th>
<th style="padding:10px 12px;text-align:center;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Constructs</th>
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Returns</th>
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">On Failure</th>
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Cleanup</th>
<th style="padding:10px 12px;text-align:left;color:#E6EDF3;border:1px solid #30363D;white-space:nowrap;">Header</th>
</tr>
</thead>
<tbody>
<tr style="border-bottom:1px solid #21262D;">
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">Regular new</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#58A6FF;font-size:12px;">new T(args)</code></td>
<td style="padding:9px 12px;text-align:center;color:#3FB950;font-weight:700;border:1px solid #21262D;">✓</td>
<td style="padding:9px 12px;text-align:center;color:#3FB950;font-weight:700;border:1px solid #21262D;">✓</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">T*</code></td>
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">throws <code style="background:#21262D;padding:2px 4px;border-radius:3px;font-size:12px;">bad_alloc</code></td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">delete</code></td>
<td style="padding:9px 12px;color:#8B949E;border:1px solid #21262D;">none</td>
</tr>
<tr style="border-bottom:1px solid #21262D;background:#0D111788;">
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">Operator new</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#58A6FF;font-size:12px;">operator new(size)</code></td>
<td style="padding:9px 12px;text-align:center;color:#3FB950;font-weight:700;border:1px solid #21262D;">✓</td>
<td style="padding:9px 12px;text-align:center;color:#C0454A;font-weight:700;border:1px solid #21262D;">✗</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">void*</code></td>
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">throws <code style="background:#21262D;padding:2px 4px;border-radius:3px;font-size:12px;">bad_alloc</code></td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">operator delete</code></td>
<td style="padding:9px 12px;color:#8B949E;border:1px solid #21262D;">none</td>
</tr>
<tr style="border-bottom:1px solid #21262D;">
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">Placement new</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#58A6FF;font-size:12px;">new (ptr) T(args)</code></td>
<td style="padding:9px 12px;text-align:center;color:#C0454A;font-weight:700;border:1px solid #21262D;">✗</td>
<td style="padding:9px 12px;text-align:center;color:#3FB950;font-weight:700;border:1px solid #21262D;">✓</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">T*</code></td>
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">constructor throws</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">p->~T()</code></td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 4px;border-radius:3px;font-size:12px;">&lt;new&gt;</code></td>
</tr>
<tr style="background:#0D111788;">
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">malloc</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#58A6FF;font-size:12px;">malloc(size)</code></td>
<td style="padding:9px 12px;text-align:center;color:#3FB950;font-weight:700;border:1px solid #21262D;">✓</td>
<td style="padding:9px 12px;text-align:center;color:#C0454A;font-weight:700;border:1px solid #21262D;">✗</td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">void*</code></td>
<td style="padding:9px 12px;color:#C9D1D9;border:1px solid #21262D;">returns <code style="background:#21262D;padding:2px 4px;border-radius:3px;font-size:12px;">nullptr</code></td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 6px;border-radius:3px;color:#C9D1D9;font-size:12px;">free</code></td>
<td style="padding:9px 12px;border:1px solid #21262D;"><code style="background:#21262D;padding:2px 4px;border-radius:3px;font-size:12px;">&lt;cstdlib&gt;</code></td>
</tr>
</tbody>
</table>
</div>

`operator new` and `malloc` both allocate raw bytes with no constructor. `new` calls `operator new` internally for its allocation step, then runs the constructor via placement new on the returned memory.


<div style="background:#0D1117;border-radius:8px;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#C9D1D9;margin:28px 0;">
<div style="max-width:860px;margin:0 auto;">
<p style="font-family:monospace;font-size:11px;color:#58A6FF;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px;">Memory Management</p>
<p style="font-size:17px;font-weight:700;color:#E6EDF3;margin:0 0 4px;">Valid Create / Cleanup Pairs</p>
<p style="font-size:12px;color:#8B949E;margin:0 0 20px;">Every valid combination — and what is UB if you mix incorrectly.</p>
<div style="display:flex;gap:16px;margin-bottom:20px;">
<span style="font-size:12px;color:#3FB950;font-weight:700;">✓ valid</span>
<span style="font-size:12px;color:#C0454A;font-weight:700;">✗ undefined behavior</span>
</div>

<!-- Row 1: new T() -->
<div style="margin-bottom:16px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#58A6FF22;border:1px solid #58A6FF44;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#58A6FF;margin:0;line-height:1.5;">new T(args)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">allocates + constructs</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">delete p</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">destructs + deallocates</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">p-&gt;~T() + operator delete(p)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">equivalent to delete when no operators are overloaded, but dispatches to wrong operator delete if they are — always use delete directly</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">p-&gt;~T() + free(p)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">free cannot release memory from operator new; different allocator families</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">free(p)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">destructor never called and free cannot release operator new memory</span></div>
</div>

<!-- Row 2: operator new + placement new -->
<div style="margin-bottom:16px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#8B5CF622;border:1px solid #8B5CF644;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#8B5CF6;margin:0;line-height:1.5;">operator new(sizeof(T))
+ new (raw) T(args)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">manual allocate + manual construct</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">p-&gt;~T()
then operator delete(raw)</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">destruct then deallocate</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">delete p</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">delete calls operator delete internally, not raw deallocation; pointer must come from a new expression</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">p-&gt;~T() + free(raw)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">free cannot release memory from operator new; different allocator families</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">operator delete(raw)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">destructor never called; object abandoned in memory before it is released</span></div>
</div>

<!-- Row 3: malloc + placement new -->
<div style="margin-bottom:16px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#E8845A22;border:1px solid #E8845A44;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#E8845A;margin:0;line-height:1.5;">malloc(sizeof(T))
+ new (ptr) T(args)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">C allocate + manual construct</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">p-&gt;~T()
then free(ptr)</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">destruct then deallocate</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">delete p</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">delete calls operator delete internally which cannot release malloc memory; pointer must come from a new expression</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">p-&gt;~T() + operator delete(ptr)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">wrong deallocator: allocator families cannot be mixed</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">free(ptr)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">destructor never called; object abandoned in memory before it is released</span></div>
</div>

<!-- Row 4: external buffer + placement new -->
<div style="margin-bottom:16px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#2F7A4E22;border:1px solid #2F7A4E44;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#2F7A4E;margin:0;line-height:1.5;">external buffer
+ new (buf) T(args)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">no allocation + manual construct</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">p-&gt;~T() only</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">destruct only — memory is external</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">delete p</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">delete calls operator delete on a non-heap address; stack or static memory cannot be freed this way</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">operator delete(p)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">operator delete on non-heap memory is undefined; may corrupt allocator state</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">free(p)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">free on non-malloc memory is undefined; may corrupt allocator state</span></div>
</div>

<!-- Row 5: operator new raw -->
<div style="margin-bottom:16px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#444C5622;border:1px solid #444C5644;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#8B949E;margin:0;line-height:1.5;">operator new(sizeof(T))
(no construction)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">raw bytes only</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">operator delete(raw)</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">raw memory release, no destructor</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">free(raw)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">free cannot release memory from operator new; different allocator families</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">delete raw</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">delete tries to call a destructor on memory that was never an object; no constructor ran here</span></div>
</div>

<!-- Row 6: malloc raw -->
<div style="margin-bottom:20px;border:1px solid #21262D;border-radius:6px;overflow:hidden;">
<div style="background:#161B22;border-bottom:1px solid #21262D;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;">
<div style="background:#444C5622;border:1px solid #444C5644;border-radius:4px;padding:6px 12px;flex-shrink:0;"><pre style="font-family:monospace;font-size:12px;font-weight:700;color:#8B949E;margin:0;line-height:1.5;">malloc(sizeof(T))
(no construction)</pre></div>
<span style="font-size:12px;color:#8B949E;padding-top:6px;">raw bytes only</span>
</div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;background:#3FB95008;">
<span style="font-size:14px;font-weight:700;color:#3FB950;">✓</span><pre style="font-family:monospace;font-size:12px;color:#C9D1D9;margin:0;">free(ptr)</pre><span style="font-size:11px;color:#3FB950CC;font-style:italic;text-align:right;">raw memory release, no destructor</span></div>
<div style="border-bottom:1px solid #21262D;padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">operator delete(ptr)</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">operator delete cannot release malloc memory; different allocator families</span></div>
<div style="padding:10px 16px 10px 20px;display:grid;grid-template-columns:24px 1fr auto;gap:0 12px;align-items:center;">
<span style="font-size:14px;font-weight:700;color:#C0454A;">✗</span><pre style="font-family:monospace;font-size:12px;color:#8B949E;margin:0;">delete ptr</pre><span style="font-size:11px;color:#C0454A99;font-style:italic;text-align:right;">delete tries to call a destructor on memory that was never an object; no constructor ran here</span></div>
</div>

<!-- Footer rule -->
<div style="background:#161B22;border:1px solid #21262D;border-radius:6px;padding:14px 16px;">
<p style="font-size:12px;font-weight:700;color:#E6EDF3;margin:0 0 6px;">The matching rule</p>
<p style="font-size:12px;color:#8B949E;margin:0;line-height:1.7;">The deallocation function must match the allocation function: <code style="font-family:monospace;background:#21262D;padding:1px 5px;border-radius:3px;">new → delete</code>, <code style="font-family:monospace;background:#21262D;padding:1px 5px;border-radius:3px;">operator new → operator delete</code>, <code style="font-family:monospace;background:#21262D;padding:1px 5px;border-radius:3px;">malloc → free</code>. Objects constructed with placement new must have their destructor called explicitly before the memory is released. External buffers require no deallocation step at all.</p>
</div>

</div>
</div>

## Header Requirements

The header requirements are subtle and worth being precise about:

`new` and `delete` (plain, standalone): no header required. They are language keywords with built-in compiler support.

`operator new` and `operator delete` (the function forms): no header required for the global versions. `#include <new>` is needed for the nothrow overloads (`std::nothrow`) and for placement new syntax.

Placement new `new (ptr) T(args)`: requires `#include <new>`. The same header covers placement delete if needed.

`malloc`, `free`, `calloc`, `realloc`: `#include <cstdlib>`.

The `<memory>` header covers `std::construct_at`, `std::destroy_at`, `std::destroy`, `std::destroy_n`, and `std::allocator`, covered later in this post.

## The Delete Side: Three Separate Mechanisms

The same split exists on the release side.

**`delete p`**: destructs the object at `p` by calling `p->~T()`, then calls `operator delete(p)` to release the memory. Two operations in one keyword. Calling `delete` on a `nullptr` is defined and does nothing. Calling it on a pointer that was not obtained from `new` (a stack pointer, a `malloc` result, a placement-new pointer) is undefined behavior. Double `delete` is also undefined behavior.

**`operator delete(p)`**: releases memory only. No destructor called. The counterpart to `operator delete` obtained from `operator new`. Like `operator new`, it can be overloaded per class.

**Placement delete**: exists as a concept but is almost never called directly. When a placement new expression (`new (ptr) T(args...)`) throws during the constructor, the compiler automatically looks for a matching `operator delete(void*, void*)` to undo any side effects the allocation step may have had. For plain placement new on a raw buffer this is a no-op: no memory was allocated, so there is nothing to release. The compiler calls placement delete as cleanup in error paths, not as a normal cleanup mechanism. Calling it directly in user code is almost always a mistake.

## std::construct_at and Friends

C++20 added a set of constexpr-capable wrappers in `<memory>` that cover the same operations as placement new and explicit destructor calls, with cleaner syntax and constexpr support.

**`std::construct_at(ptr, args...)`**: the safe constexpr version of placement new. Constructs an object at the already-allocated memory pointed to by `ptr`. Returns `T*`. Works in constexpr contexts where placement new syntax cannot be used directly.

```cpp
#include <memory>

alignas(Widget) char buffer[sizeof(Widget)];
Widget* p = std::construct_at(reinterpret_cast<Widget*>(buffer), args...);
```

**`std::destroy_at(ptr)`**: calls `ptr->~T()` explicitly. The safe wrapper around a manual destructor call. Does not free memory. Constexpr-capable.

```cpp
std::destroy_at(p);   // destructs, does not free
```

**`std::destroy(first, last)`**: destructs a range of objects. Calls `std::destroy_at` on each element from `first` up to but not including `last`. Both arguments are pointers or iterators.

```cpp
std::destroy(widgets, widgets + count);
```

**`std::destroy_n(first, n)`**: destructs `n` objects starting at `first`. Equivalent to `std::destroy(first, first + n)`. Useful when you have a count rather than an end iterator.

```cpp
std::destroy_n(widgets, count);
```

`construct_at` and `destroy_at` are the building blocks. `destroy` and `destroy_n` are convenience wrappers for ranges. All four are in `<memory>` and all are constexpr since C++20, making them usable inside `constexpr` functions where the C++20 transient allocation rules apply.

## std::allocator: The STL's Four-Operation Split

`std::allocator<T>` is the default allocator used by every STL container. Its design separates memory management from object lifetime management, which is why `std::vector` can reserve capacity without constructing elements in the reserved slots.

The four operations map directly to the primitives above:

**`allocate(n)`**: calls `operator new(n * sizeof(T))`. Reserves raw memory for `n` objects. No constructor is called. Returns `T*` pointing to the reserved block.

**`construct(p, args...)`**: calls placement new on `p`. Constructs an object in place at the already-allocated location. This is how `std::vector::push_back` builds the new element in the buffer's next slot without allocating new memory.

**`destroy(p)`**: calls `p->~T()`. Destructs the object without releasing memory. This is how `std::vector::pop_back` removes an element without shrinking the buffer.

**`deallocate(p, n)`**: calls `operator delete(p)`. Releases the raw memory. No destructor is called.

The usage order in a container is: `allocate` first (reserve), then `construct` as objects are added, then `destroy` as objects are removed, then `deallocate` when the container releases its buffer. Memory and object lifetime are managed independently at every step.

In C++17 and later, `construct` and `destroy` moved to `std::allocator_traits` rather than being called directly on the allocator itself, but the underlying operations are identical.

## The Pattern They All Enable

Once allocation and construction are separated, one pattern falls out naturally: allocate a large block once up front, then use placement new to construct objects into slots within that block, destroy them with explicit destructor calls when done, and never touch the OS allocator again in the hot path.

```cpp
// allocate once
void* pool = operator new(N * sizeof(Widget));
Widget* slots = static_cast<Widget*>(pool);

// construct into slots as needed
Widget* w = std::construct_at(slots + i, args...);

// destroy when done with the slot
std::destroy_at(w);

// release the whole block at once
operator delete(pool);
```

This is the foundation of memory pools, arena allocators, and any lock-free data structure that needs to avoid `malloc` in its hot path. As covered in the <a href="{{ site.baseurl }}/blog/memory/prefaulting/" target="_blank" rel="noopener noreferrer">prefaulting post</a>, calling into the allocator at runtime can trigger a page fault on first touch. Pre-allocating the pool and prefaulting it before entering the hot path eliminates both the allocator overhead and the fault latency.

## Run: main.cpp

```bash
g++ -O2 -std=c++26 main.cpp -o main
./main
```

Expect `Widget constructed` and `Widget destructed` to appear for the `new`/`delete` section and the placement new section, and to be absent from the `operator new`/`operator delete` and `malloc`/`free` sections.

## Run: overload.cpp

```bash
g++ -O2 -std=c++26 overload.cpp -o overload
./overload
```

Expect the custom `operator new` and `operator delete` messages to appear even though `main` uses plain `new PooledWidget()` and `delete w` syntax.

## Output

```
$ ./main
=== new / delete: allocates and constructs, destructs and deallocates ===
  Widget constructed
  Widget destructed
=== operator new / operator delete: allocation only, no constructor or destructor ===
  (no constructor ran)
  (no destructor ran)
=== placement new: construction only, no allocation ===
  Widget constructed
  (no allocation happened, buffer already existed)
  Widget destructed
=== malloc / free: raw bytes only, never touches a constructor or destructor ===
  (no constructor ran)
  (no destructor ran)

$ ./overload
=== plain 'new PooledWidget()', calling code unchanged ===
  custom operator new called, size=1
  PooledWidget constructed
  PooledWidget destructed
  custom operator delete called
```

`Widget constructed` and `Widget destructed` appear only where a constructor and destructor were actually invoked, absent from the `operator new` and `malloc` sections. The `overload` output confirms redirection: the call site uses plain `new PooledWidget()` and `delete w` unchanged, but both the custom `operator new` and `operator delete` intercept the call. `size=1` because `PooledWidget` has no data members — an empty class still requires a minimum allocation size.




## Quick Reference

**Coming from other languages**

Most languages with automatic memory management hide the allocation/construction split entirely. The runtime handles both as one step and the programmer never sees either separately. C++ exposes the split because it has value semantics, deterministic destruction, and the ability to place objects in arbitrary memory, all of which require being able to construct an object somewhere other than the standard heap. The placement new pattern is how every C++ memory pool is implemented, and understanding it is necessary for writing any container or allocator from scratch.

**The 90% mental model**

`new` = allocate + construct. `delete` = destruct + deallocate. `operator new` = allocate only, returns `void*`, can be overloaded per class, no header needed for the global form. Placement new = construct only, into existing memory, requires `#include <new>`, must call destructor manually, never use `delete` on it. `malloc` = raw bytes only, no constructor ever, returns `nullptr` on failure, freed with `free`. `std::construct_at` and `std::destroy_at` in `<memory>` are the constexpr-capable wrappers for placement new and explicit destructor calls. `std::allocator` uses all four primitives internally: `allocate` and `deallocate` handle memory, `construct` and `destroy` handle object lifetime, kept separate so containers can reserve capacity without constructing objects.
