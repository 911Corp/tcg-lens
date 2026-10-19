import { LENS_STATES } from './config.js';

const ALLOWED = Object.freeze({
  [LENS_STATES.ACQUIRING]: new Set([LENS_STATES.TRACKING, LENS_STATES.ERROR]),
  [LENS_STATES.TRACKING]: new Set([LENS_STATES.ANALYZING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.ANALYZING]: new Set([LENS_STATES.VERIFYING, LENS_STATES.UNKNOWN, LENS_STATES.AMBIGUOUS, LENS_STATES.TRACKING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.VERIFYING]: new Set([LENS_STATES.LOCKED, LENS_STATES.AMBIGUOUS, LENS_STATES.UNKNOWN, LENS_STATES.ANALYZING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.LOCKED]: new Set([LENS_STATES.CHANGE_PENDING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.CHANGE_PENDING]: new Set([LENS_STATES.LOCKED, LENS_STATES.TRACKING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.AMBIGUOUS]: new Set([LENS_STATES.ANALYZING, LENS_STATES.VERIFYING, LENS_STATES.TRACKING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.UNKNOWN]: new Set([LENS_STATES.ANALYZING, LENS_STATES.TRACKING, LENS_STATES.ACQUIRING, LENS_STATES.ERROR]),
  [LENS_STATES.ERROR]: new Set([LENS_STATES.ACQUIRING]),
});

export class LensStateMachine {
  constructor(onChange = () => {}) {
    this.state = LENS_STATES.ACQUIRING;
    this.detail = null;
    this.onChange = onChange;
  }

  transition(next, detail = null) {
    if (next === this.state) {
      this.detail = detail;
      this.onChange({ state: this.state, detail: this.detail });
      return true;
    }
    if (!ALLOWED[this.state]?.has(next)) {
      throw new Error(`Illegal Lens transition ${this.state} -> ${next}`);
    }
    this.state = next;
    this.detail = detail;
    this.onChange({ state: next, detail });
    return true;
  }

  reset(detail = null) {
    this.state = LENS_STATES.ACQUIRING;
    this.detail = detail;
    this.onChange({ state: this.state, detail });
  }
}
