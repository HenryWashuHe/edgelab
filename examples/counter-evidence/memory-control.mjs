import OriginalWorker, { Counter } from './upstream/counter.js';

// Deliberately incorrect persistence substitute, used only as a negative control.
// It must lose its value after actual eviction; this is not an upstream defect.
export class MemoryCounter extends Counter {
  value = 0;

  async getCounterValue() {
    return this.value;
  }

  async increment(amount = 1) {
    return (this.value += amount);
  }

  async decrement(amount = 1) {
    return (this.value -= amount);
  }
}

export default OriginalWorker;
