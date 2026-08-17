/**
 * Binary min-heap over integer node ids with float priorities.
 *
 * This exists as its own file for a reason worth recording. In the Meeting C++
 * 2025 talk analysed in docs/PATHFINDING_NOTES.md §6, the Age of Empires
 * engineering director notes that their long-range A* used "the fastest linked
 * list I've ever run into in my life" for its priority queue — and that it was
 * still a major performance problem, because a linked list is the wrong data
 * structure no matter how well written. Data structure choice outranks
 * micro-optimisation.
 *
 * Backed by parallel typed arrays and reused across searches, so a search costs
 * no allocation.
 */
export class BinaryHeap {
  private nodes: Int32Array
  private priorities: Float64Array
  private size = 0

  constructor(capacity = 1024) {
    this.nodes = new Int32Array(capacity)
    this.priorities = new Float64Array(capacity)
  }

  get length(): number {
    return this.size
  }

  clear(): void {
    this.size = 0
  }

  isEmpty(): boolean {
    return this.size === 0
  }

  push(node: number, priority: number): void {
    if (this.size === this.nodes.length) this.grow()
    let i = this.size++
    this.nodes[i] = node
    this.priorities[i] = priority

    // Sift up.
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.priorities[parent]! <= this.priorities[i]!) break
      this.swap(i, parent)
      i = parent
    }
  }

  /** Returns -1 when empty. */
  pop(): number {
    if (this.size === 0) return -1
    const top = this.nodes[0]!
    this.size--
    if (this.size > 0) {
      this.nodes[0] = this.nodes[this.size]!
      this.priorities[0] = this.priorities[this.size]!
      this.siftDown(0)
    }
    return top
  }

  private siftDown(start: number): void {
    let i = start
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let smallest = i
      if (l < this.size && this.priorities[l]! < this.priorities[smallest]!) smallest = l
      if (r < this.size && this.priorities[r]! < this.priorities[smallest]!) smallest = r
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private swap(a: number, b: number): void {
    const n = this.nodes[a]!
    this.nodes[a] = this.nodes[b]!
    this.nodes[b] = n
    const p = this.priorities[a]!
    this.priorities[a] = this.priorities[b]!
    this.priorities[b] = p
  }

  private grow(): void {
    const cap = this.nodes.length * 2
    const nodes = new Int32Array(cap)
    const priorities = new Float64Array(cap)
    nodes.set(this.nodes)
    priorities.set(this.priorities)
    this.nodes = nodes
    this.priorities = priorities
  }
}
