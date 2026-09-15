// ============================================================
// Clean ESM implementation of es6-promise-pool for Vite
// Bypasses UMD / AMD global checks hijacked by Monaco Editor
// ============================================================

class EventTarget {
  constructor() {
    this._listeners = {};
  }

  addEventListener(type, listener) {
    this._listeners[type] = this._listeners[type] || [];
    if (this._listeners[type].indexOf(listener) < 0) {
      this._listeners[type].push(listener);
    }
  }

  removeEventListener(type, listener) {
    if (this._listeners[type]) {
      const p = this._listeners[type].indexOf(listener);
      if (p >= 0) {
        this._listeners[type].splice(p, 1);
      }
    }
  }

  dispatchEvent(evt) {
    if (this._listeners[evt.type] && this._listeners[evt.type].length) {
      const listeners = this._listeners[evt.type].slice();
      for (let i = 0, l = listeners.length; i < l; ++i) {
        listeners[i].call(this, evt);
      }
    }
  }
}

const isGenerator = function (func) {
  return typeof func.constructor === 'function' && func.constructor.name === 'GeneratorFunction';
};

const functionToIterator = function (func) {
  return {
    next: function () {
      const promise = func();
      return promise ? { value: promise } : { done: true };
    },
  };
};

const promiseToIterator = function (promise) {
  let called = false;
  return {
    next: function () {
      if (called) {
        return { done: true };
      }
      called = true;
      return { value: promise };
    },
  };
};

const toIterator = function (obj, PromiseCtor) {
  const type = typeof obj;
  if (type === 'object') {
    if (typeof obj.next === 'function') {
      return obj;
    }
    if (typeof obj.then === 'function') {
      return promiseToIterator(obj);
    }
  }
  if (type === 'function') {
    return isGenerator(obj) ? obj() : functionToIterator(obj);
  }
  return promiseToIterator(PromiseCtor.resolve(obj));
};

export class PromisePoolEvent {
  constructor(target, type, data) {
    this.target = target;
    this.type = type;
    this.data = data;
  }
}

export class PromisePool extends EventTarget {
  constructor(source, concurrency, options) {
    super();
    if (
      typeof concurrency !== 'number' ||
      Math.floor(concurrency) !== concurrency ||
      concurrency < 1
    ) {
      throw new Error('Invalid concurrency');
    }
    this._concurrency = concurrency;
    this._options = options || {};
    this._options.promise = this._options.promise || Promise;
    this._iterator = toIterator(source, this._options.promise);
    this._done = false;
    this._size = 0;
    this._promise = null;
    this._callbacks = null;
  }

  concurrency(value) {
    if (typeof value !== 'undefined') {
      this._concurrency = value;
      if (this.active()) {
        this._proceed();
      }
    }
    return this._concurrency;
  }

  size() {
    return this._size;
  }

  active() {
    return !!this._promise;
  }

  promise() {
    return this._promise;
  }

  start() {
    const that = this;
    const PromiseCtor = this._options.promise;
    this._promise = new PromiseCtor(function (resolve, reject) {
      that._callbacks = {
        reject,
        resolve,
      };
      that._proceed();
    });
    return this._promise;
  }

  _fireEvent(type, data) {
    this.dispatchEvent(new PromisePoolEvent(this, type, data));
  }

  _settle(error) {
    if (error) {
      this._callbacks.reject(error);
    } else {
      this._callbacks.resolve();
    }
    this._promise = null;
    this._callbacks = null;
  }

  _onPooledPromiseFulfilled(promise, result) {
    this._size--;
    if (this.active()) {
      this._fireEvent('fulfilled', {
        promise,
        result,
      });
      this._proceed();
    }
  }

  _onPooledPromiseRejected(promise, error) {
    this._size--;
    if (this.active()) {
      this._fireEvent('rejected', {
        promise,
        error,
      });
      this._settle(error || new Error('Unknown error'));
    }
  }

  _trackPromise(promise) {
    const that = this;
    promise
      .then(
        function (result) {
          that._onPooledPromiseFulfilled(promise, result);
        },
        function (error) {
          that._onPooledPromiseRejected(promise, error);
        }
      )
      .catch(function (err) {
        that._settle(new Error('Promise processing failed: ' + err));
      });
  }

  _proceed() {
    if (!this._done) {
      let result = { done: false };
      while (this._size < this._concurrency && !(result = this._iterator.next()).done) {
        this._size++;
        this._trackPromise(result.value);
      }
      this._done = result === null || !!result.done;
    }
    if (this._done && this._size === 0) {
      this._settle();
    }
  }
}

PromisePool.PromisePoolEvent = PromisePoolEvent;
PromisePool.PromisePool = PromisePool;

export default PromisePool;
