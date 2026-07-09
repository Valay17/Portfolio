---
layout: post
title: "Kernel Bypass Networking: Wire to Application without the OS in Between"
date: 2026-07-09
domain: low-latency
permalink: /blog/low-latency/kernel-bypass/
linkedin: "https://www.linkedin.com/posts/saitwadekarvalay_cpp-systems-lowlevel-share-7480781843257008128-Y7JB"
---

A network packet hitting a server takes a trip through several distinct layers before application code ever sees it. Each layer was designed to be correct and general, not fast. Kernel bypass is the decision to remove those layers entirely for the applications that cannot afford them.

## What the Normal Packet Path Actually Does

When a packet arrives at the NIC (network interface card), the following sequence happens before application code reads a single byte:

The NIC writes the incoming packet into a kernel-managed ring buffer using DMA (direct memory access), where the hardware writes directly to physical memory without CPU involvement. The NIC then raises a hardware interrupt. The CPU stops whatever it was doing, saves its register state, switches into kernel mode, and runs the interrupt handler. On Linux, the handler uses NAPI (New API), a hybrid mechanism that immediately switches from interrupt mode to polling mode when packet rate is high enough, batching multiple receives per interrupt to reduce overhead. Even with NAPI batching, the kernel is still involved on every batch.

The kernel allocates socket buffers (sk_buffs), runs the packet through the protocol stack (IP header validation, TCP/UDP demultiplexing, checksum verification), places the result in the socket's receive queue, and wakes any application blocked on `recv()`. The application makes a system call, the CPU switches back into kernel mode, the kernel copies the data from its socket buffer into the application's userspace buffer, the system call returns, and the application can read the data.

The cost points in this path are not subtle. The hardware interrupt alone adds latency variance because the CPU may be in the middle of something when it fires, and the time between the interrupt firing and the handler running depends on what else the system is doing. The kernel-to-userspace copy is a full memcpy of every packet. The two mode switches (user to kernel on interrupt, kernel to user on return) each cost hundreds of nanoseconds on a modern CPU. The total end-to-end latency for a packet on a well-tuned Linux system with standard networking is in the range of 50 to 100 microseconds on a local network, with significant jitter.

## The Two Things Kernel Bypass Removes

Kernel bypass removes two things, and they are not equally important.

The first is the copy. With kernel bypass, the application registers memory buffers with the NIC ahead of time. The NIC writes incoming packet data directly into those registered buffers using DMA. The packet is never in a kernel buffer. It goes from the wire to the NIC hardware to the application's memory in a single DMA write. No memcpy, no intermediate buffer, no allocation at receive time.

The second is the interrupt, and this is usually the larger win. Kernel bypass replaces interrupt-driven receive with polling. A dedicated CPU core runs in a tight busy loop, continuously reading the NIC's receive queue descriptor ring to check whether new packets have arrived. No interrupt fires, no mode switch to kernel happens, no context switch occurs. The application code is the first thing that touches the packet after the NIC's DMA write completes.

Together: no interrupt, no kernel involvement, no copy. The data path is wire to NIC to registered application memory, with nothing in between. The latency floor drops to low single-digit microseconds, and more importantly, the jitter caused by interrupt timing and scheduler decisions disappears from the critical path.

## DMA and the Registered Memory Model

The zero-copy property depends on memory registration, and registration has requirements that matter for how the application manages memory.

Registered memory must be pinned: the physical addresses of the registered buffers cannot change while the NIC holds a reference to them. If the kernel moves or swaps the backing physical pages, the NIC's DMA will write to whatever physical address it last knew, which is now the wrong place. The result is silent corruption.

In practice this means hugepages. Hugepages (2MB or 1GB on x86) are pinned in physical memory by design in most kernel bypass frameworks. They also reduce TLB pressure since the NIC interacts with memory through physical addresses, and the IOMMU (I/O memory management unit) translates device-visible addresses to physical addresses using page tables similar to the CPU's. Fewer, larger pages means fewer IOMMU table entries and fewer IOMMU TLB misses on the device side.

The memory model is pre-allocation. A pool of packet buffers is allocated and registered with the NIC at startup. When a packet arrives, the NIC picks a buffer from the pool and DMA-writes into it. When the application finishes processing the packet, it returns the buffer to the pool. Nothing is allocated or freed in the hot path. `malloc` and `free` never appear in the receive loop. This is one reason kernel bypass code avoids standard C++ containers and allocators in the data path entirely.

## Polling: Determinism Over Efficiency

The choice to poll instead of using interrupts is a deliberate trade of CPU efficiency for latency determinism.

```cpp
// traditional: interrupt-driven
// the OS wakes your process up when data arrives
recv(socket, buffer, size, 0);   // blocks, kernel notifies you

// kernel bypass: polling
// your code checks the NIC directly, in a loop, forever
while (true) {
    int n = poll_nic_rx_queue(nic_handle, buffer);
    if (n > 0) process(buffer, n);
}
```

An interrupt-driven system uses the CPU only when there is work to do. Between packets, the core can do other things or enter a low-power state. The cost is that the CPU has no warning before the interrupt fires, and the response time depends on what the CPU was doing and what other interrupts are pending.

A polling system wastes CPU cycles whenever there is nothing to receive, since the core is spinning regardless. The benefit is that the response time from packet arrival to detection is bounded by one iteration of the polling loop, typically tens of nanoseconds. There is no interrupt latency, no scheduler involvement, and no jitter from competing work on the same core.

For workloads where packet arrival rate is high and consistent, polling is also more efficient in throughput terms. Processing 10 million packets per second with polling costs one core. Processing the same rate with interrupts costs multiple interrupts per microsecond, with all the mode-switch and handler overhead per interrupt. NAPI helps by batching but does not eliminate the kernel involvement.

For workloads where packet arrival rate is unpredictable or low, polling is pure waste. A core spinning at 100% to receive 1000 packets per second is hard to justify.

## The NIC Ring Buffer

The receive side of a kernel bypass setup is built around a descriptor ring, a fixed-size circular array that the NIC and the application both have access to.

Each descriptor in the ring holds a physical address pointing to one pre-allocated packet buffer from the application's pool, plus fields the NIC fills in when it writes a packet: length, status flags, hardware timestamp if the NIC supports it. The NIC maintains a tail pointer it advances as it fills descriptors. The application maintains a head pointer it advances as it processes packets and recycles buffers back to the ring.

This is structurally a hardware SPSC (single-producer single-consumer) queue. The NIC is the producer, the application is the consumer. No locking is needed because only one side writes and only one side reads. The only synchronization required is a memory fence to ensure the application sees the NIC's write before reading the length field, and a write to the head pointer register to tell the NIC how many buffers have been returned.

The polling loop reads the NIC's tail pointer, checks whether it has advanced past the head, and if so processes the packets in between. On modern hardware, reading the tail pointer is a memory-mapped register read, which the CPU handles like any other memory access once the address is in TLB. No system call, no kernel involvement, just a load instruction from a specific physical address range that the NIC firmware responds to.

## Implementations: DPDK, RDMA, and AF_XDP

Data Plane Development Kit (DPDK) is the most widely used framework for kernel bypass on Linux. It provides drivers that let the application take over the NIC entirely, handles the hugepage memory pool setup, and manages core binding so the polling loop runs isolated from the kernel scheduler. The kernel loses all visibility into those network interfaces once DPDK takes them over.

Remote direct memory access (RDMA) is a related but distinct form of bypass where a remote machine can read from or write to local application memory directly, without the local CPU being involved in the transfer at all. It is used in HFT for distributing market data within a data center at sub-microsecond latency per update, since the target machine's CPU does not need to participate in receiving the data.

AF_XDP is a Linux kernel feature that sits between standard sockets and full kernel bypass. It redirects selected packets into application memory without taking over the NIC entirely, so the rest of the system can still use the same interface. Latency is better than standard sockets but not as low as DPDK since some kernel code still runs per packet.

## CPU Dedication: the Real Cost

The polling core running at 100% CPU utilization is not just a power concern. It has thermal and performance implications that matter on real hardware.

On CPUs with dynamic frequency scaling (boost), a core running at 100% will boost to its maximum single-thread frequency, generating maximum heat. Adjacent cores on the same die share thermal budget. Sustained polling on one core can suppress the boost frequency available to neighboring cores. On chiplet designs where multiple cores share a heat sink, a dedicated polling core can affect the thermal headroom of the entire CCD.

Hyper-threading is typically disabled on polling cores in production kernel bypass deployments. A logical sibling thread sharing the same physical core's execution resources introduces latency jitter even if the sibling thread is doing no user work, because kernel background tasks, interrupt handlers routed to that logical CPU, and the CPU's own hardware prefetcher behavior all change when the sibling is active.

The question of when dedicating a full core to polling is worth it has a quantitative answer. If the cost of adding latency to packet processing (measured in lost opportunity, in compliance with SLA, in the value of being faster than a competitor) exceeds the cost of the core (server cost, power, thermal), then it is worth it. In HFT, that calculation is almost always resolved in favor of the polling core. In an API server handling REST requests at p99 latency of 50ms, the same calculation goes the other way.

## NUMA, Hugepages, and the Memory Stack Under Bypass

Kernel bypass does not operate in isolation from the hardware constraints covered in the NUMA post. A NIC is attached to one NUMA node's PCIe root complex, and its DMA engine writes to physical memory through the IOMMU. If the registered packet buffers live in physical memory attached to a different NUMA node, every DMA write crosses the interconnect. For a 100GbE NIC receiving at line rate, that cross-node traffic is significant.

The correct configuration aligns all three to the same node: the NIC, the packet buffer pool, and the polling thread. DPDK's setup handles this when configured correctly. Hugepages are part of that same stack, reducing IOMMU TLB pressure and eliminating the risk of page migration on the polling core, both of which would show up directly as latency spikes in a path that has no kernel to absorb them.

## When Kernel Bypass is Worth It

The decision is not about throughput, it is about latency floor and latency consistency.

Kernel bypass is worth the complexity when the application needs a predictable, bounded response time from packet arrival to application processing, and that bound needs to be in the single-digit microsecond range. HFT order handling, market data processing, and telecom user plane processing (5G packet forwarding at the RAN) all fit this profile. The interrupt jitter alone from standard networking, which can vary from a few microseconds to tens of microseconds depending on what else the system is doing, exceeds the total latency budget for these applications.

It is overkill when the application's latency budget is in the tens of milliseconds, when packet arrival rate is low or bursty, or when the engineering cost of managing registered memory pools and dedicated polling cores exceeds the value of the latency reduction. Most web services, database servers, and message brokers fall into this category. Their latency is dominated by application logic, disk I/O, or network round trips, none of which kernel bypass touches.


## Quick Reference

**Coming from other languages**

The kernel bypass concepts are not language-specific. The constraint is the operating system interface, not the language on top of it. Any language that calls the standard socket API eventually makes a system call, gets the interrupt-driven path, pays the copy cost. The language does not matter once the packet hits the kernel's network stack. Kernel bypass frameworks like DPDK provide C APIs that any language with a C FFI can call, though the practical implementations in production are almost all in C or C++ because the data path code has zero tolerance for garbage collection pauses or runtime overhead.

**The 90% mental model**

Standard networking: interrupt fires when packet arrives, kernel copies packet from its buffer to application memory, two mode switches, variable latency in the tens of microseconds. Kernel bypass: application registers memory with the NIC before packets arrive, NIC DMA-writes packets directly there, a dedicated CPU core polls the NIC's ring buffer in a tight loop, no interrupt fires, no kernel is involved, no copy happens. The latency floor drops to single-digit microseconds with minimal jitter. The cost is one full CPU core at 100% utilization and the complexity of managing pinned hugepage memory pools and the packet processing pipeline yourself. Worth it when the latency budget demands it, overkill when it does not.
