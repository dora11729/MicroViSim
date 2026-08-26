export default class SimulationRandom {
  // Setting random seed.
  private static instance?: SimulationRandom;
  static getInstance = () => this.instance || (this.instance = new this());

  private state = 0;

  private constructor() {
    this.reset();
  }

  reset(seed?: number): number {
    const effectiveSeed = seed ?? Math.floor(Math.random() * 0xffffffff);
    this.state = effectiveSeed | 0;
    return effectiveSeed;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
