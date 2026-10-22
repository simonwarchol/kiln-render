/* @ts-self-types="./brush_js.d.ts" */

/**
 * Owns the Brush runtime state (wgpu device, panic hook, etc.). Holds nothing
 * per-training-run — each [`Self::start_training_from_directory`] call
 * returns a fresh [`Training`] you drive yourself.
 */
export class BrushApp {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrushAppFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brushapp_free(ptr, 0);
    }
    /**
     * Initialize Brush with its own internal `GPUDevice`.
     * @returns {Promise<void>}
     */
    init() {
        const ret = wasm.brushapp_init(this.__wbg_ptr);
        return ret;
    }
    /**
     * Initialize Brush against an existing `(GPUAdapter, GPUDevice, GPUQueue)`
     * triple. Use this when the host app already has a WebGPU device and
     * wants Brush to train on the same one — splat buffers exposed via
     * [`BrushSplats::buffers`] then bind directly into the host's render
     * pipelines without copies.
     * @param {any} adapter
     * @param {any} device
     * @param {any} queue
     */
    initExisting(adapter, device, queue) {
        const ret = wasm.brushapp_initExisting(this.__wbg_ptr, adapter, device, queue);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Construct a `BrushApp`. Installs the wasm panic hook + logger and
     * applies the global `CubeCL` config. You must `await app.init()`
     * (or call `app.initExisting(...)`) before starting any training.
     */
    constructor() {
        const ret = wasm.brushapp_new();
        this.__wbg_ptr = ret;
        BrushAppFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Start training from a directory picked via `window.showDirectoryPicker()`.
     *
     * `config_fn` is called once with the initial [`TrainStreamConfig`] —
     * loaded from `args.txt` in the chosen directory if present, defaults
     * otherwise — serialized as a plain JS object. It must return a Promise
     * resolving to the final config (or `null` to abort).
     *
     * The returned [`Training`] owns the underlying message stream. Drive it
     * with `await training.trainSteps(N)`. To cancel, just drop it
     * (`training.free()` synchronously, or let GC do it eventually) — Rust's
     * normal future cancellation tears down any pending Burn work.
     *
     * To pause, just stop pumping; the training loop back-pressures
     * because nothing is consuming messages.
     * @param {FileSystemDirectoryHandle} handle
     * @param {Function} config_fn
     * @returns {Training}
     */
    startTrainingFromDirectory(handle, config_fn) {
        const ret = wasm.brushapp_startTrainingFromDirectory(this.__wbg_ptr, handle, config_fn);
        return Training.__wrap(ret);
    }
}
if (Symbol.dispose) BrushApp.prototype[Symbol.dispose] = BrushApp.prototype.free;

/**
 * Opaque wrapper around the Rust [`ProcessMessage`] enum.
 */
export class BrushMessage {
    static __wrap(ptr) {
        const obj = Object.create(BrushMessage.prototype);
        obj.__wbg_ptr = ptr;
        BrushMessageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrushMessageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brushmessage_free(ptr, 0);
    }
    /**
     * @returns {number | undefined}
     */
    get elapsedMs() {
        const ret = wasm.brushmessage_elapsedMs(this.__wbg_ptr);
        return ret[0] === 0 ? undefined : ret[1];
    }
    /**
     * @returns {number | undefined}
     */
    get evalViews() {
        const ret = wasm.brushmessage_evalViews(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get iter() {
        const ret = wasm.brushmessage_iter(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {BrushMessageKind}
     */
    get kind() {
        const ret = wasm.brushmessage_kind(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string | undefined}
     */
    get name() {
        const ret = wasm.brushmessage_name(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {number | undefined}
     */
    get numSplats() {
        const ret = wasm.brushmessage_numSplats(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get psnr() {
        const ret = wasm.brushmessage_psnr(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get shDegree() {
        const ret = wasm.brushmessage_shDegree(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {number | undefined}
     */
    get ssim() {
        const ret = wasm.brushmessage_ssim(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {string | undefined}
     */
    get text() {
        const ret = wasm.brushmessage_text(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {number | undefined}
     */
    get trainViews() {
        const ret = wasm.brushmessage_trainViews(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
}
if (Symbol.dispose) BrushMessage.prototype[Symbol.dispose] = BrushMessage.prototype.free;

/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}
 */
export const BrushMessageKind = Object.freeze({
    NewProcess: 0, "0": "NewProcess",
    StartLoading: 1, "1": "StartLoading",
    SplatsUpdated: 2, "2": "SplatsUpdated",
    DatasetLoaded: 3, "3": "DatasetLoaded",
    TrainStep: 4, "4": "TrainStep",
    RefineStep: 5, "5": "RefineStep",
    EvalResult: 6, "6": "EvalResult",
    DoneTraining: 7, "7": "DoneTraining",
    DoneLoading: 8, "8": "DoneLoading",
    Warning: 9, "9": "Warning",
});

/**
 * Snapshot of the GPU buffers backing a [`BrushSplats`]. All three buffers
 * live on the [`GPUDevice`] Brush is training on, so they can be bound
 * directly to render pipelines on that same device with no copies.
 */
export class BrushSplatBuffers {
    static __wrap(ptr) {
        const obj = Object.create(BrushSplatBuffers.prototype);
        obj.__wbg_ptr = ptr;
        BrushSplatBuffersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrushSplatBuffersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brushsplatbuffers_free(ptr, 0);
    }
    /**
     * Per-splat raw (pre-sigmoid) opacities `[N]`.
     * @returns {any}
     */
    get rawOpacities() {
        const ret = wasm.brushsplatbuffers_rawOpacities(this.__wbg_ptr);
        return ret;
    }
    /**
     * Spherical-harmonics coefficients `[N, n_coeffs, 3]`, where
     * `n_coeffs = (sh_degree + 1)^2`.
     * @returns {any}
     */
    get shCoeffs() {
        const ret = wasm.brushsplatbuffers_shCoeffs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Packed `[N, 10]` `GPUBuffer`. Each row is
     * `means(3) | rotation_xyzw(4) | log_scales(3)`, stride 40 bytes.
     * Bind as a vertex buffer with attributes at offsets 0 / 12 / 28.
     * @returns {any}
     */
    get transforms() {
        const ret = wasm.brushsplatbuffers_transforms(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) BrushSplatBuffers.prototype[Symbol.dispose] = BrushSplatBuffers.prototype.free;

export class BrushSplats {
    static __wrap(ptr) {
        const obj = Object.create(BrushSplats.prototype);
        obj.__wbg_ptr = ptr;
        BrushSplatsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrushSplatsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brushsplats_free(ptr, 0);
    }
    /**
     * All three GPU buffers backing this snapshot. Returns `null` if Brush
     * isn't running on the WebGPU backend.
     * @returns {BrushSplatBuffers | undefined}
     */
    buffers() {
        const ret = wasm.brushsplats_buffers(this.__wbg_ptr);
        return ret === 0 ? undefined : BrushSplatBuffers.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get numSplats() {
        const ret = wasm.brushsplats_numSplats(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get shDegree() {
        const ret = wasm.brushsplats_shDegree(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) BrushSplats.prototype[Symbol.dispose] = BrushSplats.prototype.free;

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * A single training run. Owns the underlying brush-process stream + splat
 * view; dropping it cancels the run.
 */
export class Training {
    static __wrap(ptr) {
        const obj = Object.create(Training.prototype);
        obj.__wbg_ptr = ptr;
        TrainingFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrainingFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_training_free(ptr, 0);
    }
    /**
     * Snapshot the current splats. Returns `null` if no splats have been
     * produced yet.
     * @returns {BrushSplats | undefined}
     */
    currentSplats() {
        const ret = wasm.training_currentSplats(this.__wbg_ptr);
        return ret === 0 ? undefined : BrushSplats.__wrap(ret);
    }
    /**
     * Drive the training stream until `steps` `TrainStep` events have been
     * emitted (or the stream ends), and return every message produced along
     * the way.
     *
     * On the first call this also yields the loading-phase messages
     * (`StartLoading`, `Dataset`, initial `SplatsUpdated`, `DoneLoading`,
     * then the first `steps` `TrainStep`s). Returns an empty array when
     * the stream is fully exhausted — that's the JS host's "stop pumping"
     * signal.
     *
     * Internal `TrainConfig` echoes are filtered (implementation detail of
     * brush-process). Errors propagate as a Promise rejection; messages
     * collected before the error are dropped — re-stream a fresh
     * [`Training`] if recovery is needed.
     * @param {number} steps
     * @returns {Promise<BrushMessage[]>}
     */
    trainSteps(steps) {
        const ret = wasm.training_trainSteps(this.__wbg_ptr, steps);
        return ret;
    }
}
if (Symbol.dispose) Training.prototype[Symbol.dispose] = Training.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_ef53bc310eb298a0: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_Window_10432856308b8957: function(arg0) {
            const ret = arg0.Window;
            return ret;
        },
        __wbg_WorkerGlobalScope_cac6588d65e31fe0: function(arg0) {
            const ret = arg0.WorkerGlobalScope;
            return ret;
        },
        __wbg___wbindgen_bigint_get_as_i64_38130e98eecd467d: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_1a45e2c38d4d41b9: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_0accd80f45e5faa2: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_70a403a56e771704: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_6ffd6468a9bc44b9: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_754e9f305ff6029e: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_87c3bfe968c6a5ad: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_56732c2bc353f41d: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_c236cabd84a4d769: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_67b456be8673d3d7: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_1068e624fa87f6ab: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_2c56564c75129511: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_9bb1761122181af2: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_72bdf95d3ae505b1: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_61db23ac97f16c31: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_beginComputePass_c28e56f5817b60b8: function(arg0, arg1) {
            const ret = arg0.beginComputePass(arg1);
            return ret;
        },
        __wbg_body_61a0827da5b6d2bc: function(arg0) {
            const ret = arg0.body;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_brushmessage_new: function(arg0) {
            const ret = BrushMessage.__wrap(arg0);
            return ret;
        },
        __wbg_buffer_d370c8cae5692933: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byobRequest_2c89fb4ab478fa09: function(arg0) {
            const ret = arg0.byobRequest;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_byteLength_2c6dc3b4b85d3547: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteOffset_349aa9bf0a183eca: function(arg0) {
            const ret = arg0.byteOffset;
            return ret;
        },
        __wbg_call_8a89609d89f6608a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_9c758de292015997: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_cancel_03f2da4c8e793561: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_cancel_3dedc1c2245a59d4: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_catch_17ae9c6dfb88ad8a: function(arg0, arg1) {
            const ret = arg0.catch(arg1);
            return ret;
        },
        __wbg_click_f4ad50d5e13b83d8: function(arg0) {
            arg0.click();
        },
        __wbg_close_4859304bbf0f8208: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_6f12196fe155e8d2: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_copyBufferToBuffer_62ee3bca76d1f533: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.copyBufferToBuffer(arg1, arg2, arg3, arg4, arg5);
        }, arguments); },
        __wbg_copyBufferToBuffer_8b3e48fef154c845: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.copyBufferToBuffer(arg1, arg2, arg3, arg4);
        }, arguments); },
        __wbg_createBindGroupLayout_c3d12b0acd2a9862: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createBindGroupLayout(arg1);
            return ret;
        }, arguments); },
        __wbg_createBindGroup_e5e66b7b03fb779b: function(arg0, arg1) {
            const ret = arg0.createBindGroup(arg1);
            return ret;
        },
        __wbg_createBuffer_d211a6e21a1f349f: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createBuffer(arg1);
            return ret;
        }, arguments); },
        __wbg_createCommandEncoder_dcd44bb46848e86e: function(arg0, arg1) {
            const ret = arg0.createCommandEncoder(arg1);
            return ret;
        },
        __wbg_createComputePipeline_f49e0d5df1ca5087: function(arg0, arg1) {
            const ret = arg0.createComputePipeline(arg1);
            return ret;
        },
        __wbg_createElement_c3c16a9aa7f5cc74: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.createElement(getStringFromWasm0(arg1, arg2));
            return ret;
        }, arguments); },
        __wbg_createPipelineLayout_5024d23fc8fb3349: function(arg0, arg1) {
            const ret = arg0.createPipelineLayout(arg1);
            return ret;
        },
        __wbg_createQuerySet_571138cf5d4c191f: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createQuerySet(arg1);
            return ret;
        }, arguments); },
        __wbg_createShaderModule_3b5f6ce5f621876b: function(arg0, arg1) {
            const ret = arg0.createShaderModule(arg1);
            return ret;
        },
        __wbg_description_19755094085dff3a: function(arg0, arg1) {
            const ret = arg1.description;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_dispatchWorkgroupsIndirect_c0ccb8fff4bd6e51: function(arg0, arg1, arg2) {
            arg0.dispatchWorkgroupsIndirect(arg1, arg2);
        },
        __wbg_dispatchWorkgroups_85db820a8852b802: function(arg0, arg1, arg2, arg3) {
            arg0.dispatchWorkgroups(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0);
        },
        __wbg_document_aceb08cd6489baf5: function(arg0) {
            const ret = arg0.document;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_done_60cf307fcc680536: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_end_f50e926c5aaa89da: function(arg0) {
            arg0.end();
        },
        __wbg_enqueue_09035479e2081625: function() { return handleError(function (arg0, arg1) {
            arg0.enqueue(arg1);
        }, arguments); },
        __wbg_entries_04b37a02507f1713: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_features_de4041f8da239094: function(arg0) {
            const ret = arg0.features;
            return ret;
        },
        __wbg_fetch_ce1af4d1b59a60be: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_files_6d12882157f4016a: function(arg0) {
            const ret = arg0.files;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_finish_9a2423ecd6da3214: function(arg0) {
            const ret = arg0.finish();
            return ret;
        },
        __wbg_finish_b3e0cee2cae17d75: function(arg0, arg1) {
            const ret = arg0.finish(arg1);
            return ret;
        },
        __wbg_getBindGroupLayout_fdd970d36c9947c3: function(arg0, arg1) {
            const ret = arg0.getBindGroupLayout(arg1 >>> 0);
            return ret;
        },
        __wbg_getDirectoryHandle_1f8f2731d5aae611: function(arg0, arg1, arg2) {
            const ret = arg0.getDirectoryHandle(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_getFileHandle_9eb65ed1a1a19482: function(arg0, arg1, arg2) {
            const ret = arg0.getFileHandle(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_getFile_57f23539bd8b1536: function(arg0) {
            const ret = arg0.getFile();
            return ret;
        },
        __wbg_getMappedRange_9610546bd16773a1: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getMappedRange(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getReader_1ef752ebe7bb7900: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getReader(arg1);
            return ret;
        }, arguments); },
        __wbg_getReader_bb0230851fbf986b: function() { return handleError(function (arg0) {
            const ret = arg0.getReader();
            return ret;
        }, arguments); },
        __wbg_get_0d06c4d815368a19: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg1.get(getStringFromWasm0(arg2, arg3));
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_get_1f8f054ddbaa7db2: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_2b48c7d0d006a781: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_4aead883f84459a2: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_de6a0f7d4d18a304: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_done_ea9eb315d4ec1e81: function(arg0) {
            const ret = arg0.done;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg_get_unchecked_33f6e5c9e2f2d6b2: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_value_c68fe2e1a76c69ca: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_gpu_a77849c934bef301: function(arg0) {
            const ret = arg0.gpu;
            return ret;
        },
        __wbg_has_e103bd9d3e86988b: function(arg0, arg1, arg2) {
            const ret = arg0.has(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_headers_0feb63d2d374b44a: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_info_440b5faad8a61b6d: function(arg0) {
            const ret = arg0.info;
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_8f49811467741499: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_FileSystemDirectoryHandle_527d4a4ebcd0f631: function(arg0) {
            let result;
            try {
                result = arg0 instanceof FileSystemDirectoryHandle;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_GpuAdapter_b55f1153f66c4c98: function(arg0) {
            let result;
            try {
                result = arg0 instanceof GPUAdapter;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_GpuOutOfMemoryError_d142677a69370741: function(arg0) {
            let result;
            try {
                result = arg0 instanceof GPUOutOfMemoryError;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_GpuValidationError_4603d5e7562d0900: function(arg0) {
            let result;
            try {
                result = arg0 instanceof GPUValidationError;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlInputElement_684a7e5d7dbec24c: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLInputElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_9fc06d9a951bcee6: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Object_873c13f9f41aec78: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Object;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Promise_d0db99486956c8e8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Promise;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_cb984bd66d7bd408: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_86f30649f63ef9c2: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_e093be59ee9a8e14: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_67c2c9c4313f4448: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_66acec27e09e99a7: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_8732428d309e270e: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_label_99042577cac803b0: function(arg0, arg1) {
            const ret = arg1.label;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_length_4a591ecaa01354d9: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_66f1a4b2e9026940: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_limits_60fd123f91339f72: function(arg0) {
            const ret = arg0.limits;
            return ret;
        },
        __wbg_limits_72a16d80705c85b0: function(arg0) {
            const ret = arg0.limits;
            return ret;
        },
        __wbg_location_efdf1fea18b5552a: function(arg0) {
            const ret = arg0.location;
            return ret;
        },
        __wbg_mapAsync_408158ce151c0936: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.mapAsync(arg1 >>> 0, arg2, arg3);
            return ret;
        },
        __wbg_maxBindGroups_8ad808ed2ac8d0eb: function(arg0) {
            const ret = arg0.maxBindGroups;
            return ret;
        },
        __wbg_maxBindingsPerBindGroup_ef8ced5d2e349d6d: function(arg0) {
            const ret = arg0.maxBindingsPerBindGroup;
            return ret;
        },
        __wbg_maxBufferSize_f6faac7d3fa31300: function(arg0) {
            const ret = arg0.maxBufferSize;
            return ret;
        },
        __wbg_maxColorAttachmentBytesPerSample_fc0575180ae7d46f: function(arg0) {
            const ret = arg0.maxColorAttachmentBytesPerSample;
            return ret;
        },
        __wbg_maxColorAttachments_aff469a2c6b52dae: function(arg0) {
            const ret = arg0.maxColorAttachments;
            return ret;
        },
        __wbg_maxComputeInvocationsPerWorkgroup_53b49b93a9f7a4d1: function(arg0) {
            const ret = arg0.maxComputeInvocationsPerWorkgroup;
            return ret;
        },
        __wbg_maxComputeWorkgroupSizeX_af4c20e09fe72209: function(arg0) {
            const ret = arg0.maxComputeWorkgroupSizeX;
            return ret;
        },
        __wbg_maxComputeWorkgroupSizeY_d2bad83d82f881a4: function(arg0) {
            const ret = arg0.maxComputeWorkgroupSizeY;
            return ret;
        },
        __wbg_maxComputeWorkgroupSizeZ_7efd265b94e78f98: function(arg0) {
            const ret = arg0.maxComputeWorkgroupSizeZ;
            return ret;
        },
        __wbg_maxComputeWorkgroupStorageSize_7d3805278a52917a: function(arg0) {
            const ret = arg0.maxComputeWorkgroupStorageSize;
            return ret;
        },
        __wbg_maxComputeWorkgroupsPerDimension_6e71e00fbbb624b8: function(arg0) {
            const ret = arg0.maxComputeWorkgroupsPerDimension;
            return ret;
        },
        __wbg_maxDynamicStorageBuffersPerPipelineLayout_795effce3afe7b39: function(arg0) {
            const ret = arg0.maxDynamicStorageBuffersPerPipelineLayout;
            return ret;
        },
        __wbg_maxDynamicUniformBuffersPerPipelineLayout_22b28113b385d8dd: function(arg0) {
            const ret = arg0.maxDynamicUniformBuffersPerPipelineLayout;
            return ret;
        },
        __wbg_maxInterStageShaderVariables_abe207c14c11478d: function(arg0) {
            const ret = arg0.maxInterStageShaderVariables;
            return ret;
        },
        __wbg_maxSampledTexturesPerShaderStage_56af8730f0966c5c: function(arg0) {
            const ret = arg0.maxSampledTexturesPerShaderStage;
            return ret;
        },
        __wbg_maxSamplersPerShaderStage_69fea41cc64287f2: function(arg0) {
            const ret = arg0.maxSamplersPerShaderStage;
            return ret;
        },
        __wbg_maxStorageBufferBindingSize_ec5cbeb2144dd6a1: function(arg0) {
            const ret = arg0.maxStorageBufferBindingSize;
            return ret;
        },
        __wbg_maxStorageBuffersPerShaderStage_8724449d120df860: function(arg0) {
            const ret = arg0.maxStorageBuffersPerShaderStage;
            return ret;
        },
        __wbg_maxStorageTexturesPerShaderStage_c210e5481b3a94cb: function(arg0) {
            const ret = arg0.maxStorageTexturesPerShaderStage;
            return ret;
        },
        __wbg_maxTextureArrayLayers_d17c52fe10e4a1bb: function(arg0) {
            const ret = arg0.maxTextureArrayLayers;
            return ret;
        },
        __wbg_maxTextureDimension1D_c4585fcded10849c: function(arg0) {
            const ret = arg0.maxTextureDimension1D;
            return ret;
        },
        __wbg_maxTextureDimension2D_3c0fa7b5b2d61e53: function(arg0) {
            const ret = arg0.maxTextureDimension2D;
            return ret;
        },
        __wbg_maxTextureDimension3D_8f24524797caa040: function(arg0) {
            const ret = arg0.maxTextureDimension3D;
            return ret;
        },
        __wbg_maxUniformBufferBindingSize_01a858f467301106: function(arg0) {
            const ret = arg0.maxUniformBufferBindingSize;
            return ret;
        },
        __wbg_maxUniformBuffersPerShaderStage_8791c8be3b0a772c: function(arg0) {
            const ret = arg0.maxUniformBuffersPerShaderStage;
            return ret;
        },
        __wbg_maxVertexAttributes_6432cff50e389780: function(arg0) {
            const ret = arg0.maxVertexAttributes;
            return ret;
        },
        __wbg_maxVertexBufferArrayStride_e13250aed973e312: function(arg0) {
            const ret = arg0.maxVertexBufferArrayStride;
            return ret;
        },
        __wbg_maxVertexBuffers_4aacc8c4bb0f414a: function(arg0) {
            const ret = arg0.maxVertexBuffers;
            return ret;
        },
        __wbg_message_e8d6caaa74d769a2: function(arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_minStorageBufferOffsetAlignment_5d6ec0c49c7cdd39: function(arg0) {
            const ret = arg0.minStorageBufferOffsetAlignment;
            return ret;
        },
        __wbg_minUniformBufferOffsetAlignment_80e9af0d17b91abf: function(arg0) {
            const ret = arg0.minUniformBufferOffsetAlignment;
            return ret;
        },
        __wbg_name_2b1afe861fc08636: function(arg0, arg1) {
            const ret = arg1.name;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_name_e1829143ad527577: function(arg0, arg1) {
            const ret = arg1.name;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_navigator_3833ecdbc19d2757: function(arg0) {
            const ret = arg0.navigator;
            return ret;
        },
        __wbg_navigator_391291470f58c650: function(arg0) {
            const ret = arg0.navigator;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_50bb5ebeecef71a8: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_578aeef4b6b94378: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_622fc80556be2e26: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_b682b81e8eaaf027: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h45b39f3f0a75185b(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_ce1ab61c1c2b300d: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_d90091b82fdf5b91: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_typed_bf31d18f92484486: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h45b39f3f0a75185b(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_byte_offset_and_length_d836f26d916dd9ad: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_length_36a4998e27b014c5: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_str_and_init_bcd02b79a793d27f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_9e03acdf51c4960d: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_eb8ca7351fa27906: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_ok_fb13c30bc1893039: function(arg0) {
            const ret = arg0.ok;
            return ret;
        },
        __wbg_onSubmittedWorkDone_5c51135feb434c5a: function(arg0) {
            const ret = arg0.onSubmittedWorkDone();
            return ret;
        },
        __wbg_origin_d4fcb992a8589439: function() { return handleError(function (arg0, arg1) {
            const ret = arg1.origin;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_popErrorScope_f828543e6ebda4d7: function(arg0) {
            const ret = arg0.popErrorScope();
            return ret;
        },
        __wbg_prototypesetcall_3249fc62a0fafa30: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_pushErrorScope_ae0245b1a9ebd84e: function(arg0, arg1) {
            arg0.pushErrorScope(__wbindgen_enum_GpuErrorFilter[arg1]);
        },
        __wbg_push_a6822215aa43e71c: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_35c611f4a14830b2: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_queueMicrotask_404ed0a58e0b63cc: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queue_433ceb2654eea7bb: function(arg0) {
            const ret = arg0.queue;
            return ret;
        },
        __wbg_read_282e152a24fd0856: function(arg0) {
            const ret = arg0.read();
            return ret;
        },
        __wbg_read_2c0fbe204bc2d6b7: function(arg0, arg1) {
            const ret = arg0.read(arg1);
            return ret;
        },
        __wbg_releaseLock_a6870ff38baedd72: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_releaseLock_cd76770b7f82a961: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_requestAdapter_abe9a8ec8c20fe26: function(arg0, arg1) {
            const ret = arg0.requestAdapter(arg1);
            return ret;
        },
        __wbg_requestDevice_f57ca1ab9609a2f3: function(arg0, arg1) {
            const ret = arg0.requestDevice(arg1);
            return ret;
        },
        __wbg_resolveQuerySet_1d14d56edafe91d4: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.resolveQuerySet(arg1, arg2 >>> 0, arg3 >>> 0, arg4, arg5 >>> 0);
        },
        __wbg_resolve_25a7e548d5881dca: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_respond_33b6f330b6d299fd: function() { return handleError(function (arg0, arg1) {
            arg0.respond(arg1 >>> 0);
        }, arguments); },
        __wbg_setBindGroup_1f6f83964f1e3460: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.setBindGroup(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4), arg5, arg6 >>> 0);
        }, arguments); },
        __wbg_setBindGroup_51442d71090722bb: function(arg0, arg1, arg2) {
            arg0.setBindGroup(arg1 >>> 0, arg2);
        },
        __wbg_setPipeline_313ba88ef3867886: function(arg0, arg1) {
            arg0.setPipeline(arg1);
        },
        __wbg_setTimeout_8e5bfcf7c0979a19: function(arg0, arg1) {
            globalThis.setTimeout(arg0, arg1);
        },
        __wbg_set_29c99a8aac1c01e5: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_52b1e1eb5bed906a: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_6e30c9374c26414c: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_access_1f7e7ded3f9f4c51: function(arg0, arg1) {
            arg0.access = __wbindgen_enum_GpuStorageTextureAccess[arg1];
        },
        __wbg_set_beginning_of_pass_write_index_12519893891ffe47: function(arg0, arg1) {
            arg0.beginningOfPassWriteIndex = arg1 >>> 0;
        },
        __wbg_set_bind_group_layouts_5364e662d8e238b8: function(arg0, arg1) {
            arg0.bindGroupLayouts = arg1;
        },
        __wbg_set_binding_09cae169aa5dda3e: function(arg0, arg1) {
            arg0.binding = arg1 >>> 0;
        },
        __wbg_set_binding_c069b5e6b8f6f653: function(arg0, arg1) {
            arg0.binding = arg1 >>> 0;
        },
        __wbg_set_buffer_5190032ec11dd648: function(arg0, arg1) {
            arg0.buffer = arg1;
        },
        __wbg_set_buffer_e534c561bb6c3dcf: function(arg0, arg1) {
            arg0.buffer = arg1;
        },
        __wbg_set_c775d84916be79ea: function(arg0, arg1, arg2) {
            arg0.set(arg1, arg2 >>> 0);
        },
        __wbg_set_code_011561dd20c1efd4: function(arg0, arg1, arg2) {
            arg0.code = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_compute_f84cddd7638c615e: function(arg0, arg1) {
            arg0.compute = arg1;
        },
        __wbg_set_count_1de8a328fc6266ed: function(arg0, arg1) {
            arg0.count = arg1 >>> 0;
        },
        __wbg_set_dca99999bba88a9a: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_end_of_pass_write_index_65984207d89c0719: function(arg0, arg1) {
            arg0.endOfPassWriteIndex = arg1 >>> 0;
        },
        __wbg_set_entries_7552f4c8809e95ff: function(arg0, arg1) {
            arg0.entries = arg1;
        },
        __wbg_set_entries_d359e5128c8d3cbf: function(arg0, arg1) {
            arg0.entries = arg1;
        },
        __wbg_set_entry_point_2380575eaa6771ec: function(arg0, arg1, arg2) {
            arg0.entryPoint = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_external_texture_1dcf2339bbeb7bb3: function(arg0, arg1) {
            arg0.externalTexture = arg1;
        },
        __wbg_set_format_86e8fcbe39bb0f44: function(arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        },
        __wbg_set_has_dynamic_offset_5d4996d8f99b8fb2: function(arg0, arg1) {
            arg0.hasDynamicOffset = arg1 !== 0;
        },
        __wbg_set_label_236edfab2113b8bc: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_29ae19c66fc1279e: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_2cb83895da271fc3: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_3d4267ac4da84688: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_8a928ad5af54a433: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_a636918c508a3b4b: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_a7d99c2c9f511d37: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_c32d8a8738d160ea: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_c814314b07398e94: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_dcc0c5d34b0050e0: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_label_f66085d2f0e3bc55: function(arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_layout_2e2372acff4daa50: function(arg0, arg1) {
            arg0.layout = arg1;
        },
        __wbg_set_layout_fce12d49d6efbd22: function(arg0, arg1) {
            arg0.layout = arg1;
        },
        __wbg_set_mapped_at_creation_6c363f488a3b0660: function(arg0, arg1) {
            arg0.mappedAtCreation = arg1 !== 0;
        },
        __wbg_set_method_7a6811dec7a4feff: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_min_binding_size_1719cb4198c17519: function(arg0, arg1) {
            arg0.minBindingSize = arg1;
        },
        __wbg_set_mode_23e91269c13e446c: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_ReadableStreamReaderMode[arg1];
        },
        __wbg_set_mode_c90e3667002857d4: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_module_eee91936f858860f: function(arg0, arg1) {
            arg0.module = arg1;
        },
        __wbg_set_multisampled_195d4c3be45b3e53: function(arg0, arg1) {
            arg0.multisampled = arg1 !== 0;
        },
        __wbg_set_offset_6cd47388b975b864: function(arg0, arg1) {
            arg0.offset = arg1;
        },
        __wbg_set_onchange_b3e8750f3ff32af9: function(arg0, arg1) {
            arg0.onchange = arg1;
        },
        __wbg_set_power_preference_d8f02770d0e9b3c3: function(arg0, arg1) {
            arg0.powerPreference = __wbindgen_enum_GpuPowerPreference[arg1];
        },
        __wbg_set_query_set_3a2077423893931c: function(arg0, arg1) {
            arg0.querySet = arg1;
        },
        __wbg_set_required_features_165505e2f29e9066: function(arg0, arg1) {
            arg0.requiredFeatures = arg1;
        },
        __wbg_set_required_limits_215ec386afd532b1: function(arg0, arg1) {
            arg0.requiredLimits = arg1;
        },
        __wbg_set_resource_d0f8410d251eeef5: function(arg0, arg1) {
            arg0.resource = arg1;
        },
        __wbg_set_sample_type_d518f7ed55c8cccd: function(arg0, arg1) {
            arg0.sampleType = __wbindgen_enum_GpuTextureSampleType[arg1];
        },
        __wbg_set_sampler_57ac8c4f50b88b4a: function(arg0, arg1) {
            arg0.sampler = arg1;
        },
        __wbg_set_size_007d7f0ea072280a: function(arg0, arg1) {
            arg0.size = arg1;
        },
        __wbg_set_size_61a060a41fe491fd: function(arg0, arg1) {
            arg0.size = arg1;
        },
        __wbg_set_storage_texture_397a3d432ffbabda: function(arg0, arg1) {
            arg0.storageTexture = arg1;
        },
        __wbg_set_texture_ee488edea50f58ba: function(arg0, arg1) {
            arg0.texture = arg1;
        },
        __wbg_set_timestamp_writes_b5e93d075750bcbe: function(arg0, arg1) {
            arg0.timestampWrites = arg1;
        },
        __wbg_set_type_3c0ef91d2f4fad21: function(arg0, arg1, arg2) {
            arg0.type = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_type_4667651ce4961ab7: function(arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuQueryType[arg1];
        },
        __wbg_set_type_b203aab1d4646d0f: function(arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuSamplerBindingType[arg1];
        },
        __wbg_set_type_b6bd67f968b03a25: function(arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuBufferBindingType[arg1];
        },
        __wbg_set_usage_395853abd852b88e: function(arg0, arg1) {
            arg0.usage = arg1 >>> 0;
        },
        __wbg_set_view_dimension_271d3c7e4f89f250: function(arg0, arg1) {
            arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
        },
        __wbg_set_view_dimension_438115bdd1decfde: function(arg0, arg1) {
            arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
        },
        __wbg_set_visibility_f501187cf62a3387: function(arg0, arg1) {
            arg0.visibility = arg1 >>> 0;
        },
        __wbg_size_4a0632f854af7170: function(arg0) {
            const ret = arg0.size;
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_9d53f2689e622ca1: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_a1a35cec07001a8a: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_4c59f6c7ea29a144: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_e70ae9f2eb052253: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_00549d55b78d949e: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_stream_195ccb9d9eb09fd6: function(arg0) {
            const ret = arg0.stream();
            return ret;
        },
        __wbg_subarray_4aa221f6a4f5ab22: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_submit_7c68119ebea57e67: function(arg0, arg1) {
            arg0.submit(arg1);
        },
        __wbg_then_18f476d590e58992: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_529ea37d9bdbf95d: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_ac7b025999b52837: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_toString_1fcc5569307bd3f3: function(arg0) {
            const ret = arg0.toString();
            return ret;
        },
        __wbg_unmap_c86c2c234a7f309c: function(arg0) {
            arg0.unmap();
        },
        __wbg_usage_383a6d96582948fb: function(arg0) {
            const ret = arg0.usage;
            return ret;
        },
        __wbg_value_f3625092ee4b37f4: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_view_d523e3b92648b62c: function(arg0) {
            const ret = arg0.view;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_writeBuffer_1d7c317c4fe64a8e: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.writeBuffer(arg1, arg2, getArrayU8FromWasm0(arg3, arg4), arg5, arg6);
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 14388, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h9af0192d2ec8538e);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 15616, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hfaeaf6edeec33a5a);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 15671, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h1db26fa635b382a4);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("Event")], shim_idx: 15587, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h510a9b49c2d9d8ee);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_cast_000000000000000a: function(arg0, arg1) {
            var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 4, 4);
            // Cast intrinsic for `Vector(NamedExternref("BrushMessage")) -> Externref`.
            const ret = v0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./brush_js_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h9af0192d2ec8538e(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h9af0192d2ec8538e(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hfaeaf6edeec33a5a(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__hfaeaf6edeec33a5a(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h510a9b49c2d9d8ee(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h510a9b49c2d9d8ee(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h1db26fa635b382a4(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h1db26fa635b382a4(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h45b39f3f0a75185b(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h45b39f3f0a75185b(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_GpuBufferBindingType = ["uniform", "storage", "read-only-storage"];


const __wbindgen_enum_GpuErrorFilter = ["validation", "out-of-memory", "internal"];


const __wbindgen_enum_GpuPowerPreference = ["low-power", "high-performance"];


const __wbindgen_enum_GpuQueryType = ["occlusion", "timestamp"];


const __wbindgen_enum_GpuSamplerBindingType = ["filtering", "non-filtering", "comparison"];


const __wbindgen_enum_GpuStorageTextureAccess = ["write-only", "read-only", "read-write"];


const __wbindgen_enum_GpuTextureFormat = ["r8unorm", "r8snorm", "r8uint", "r8sint", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32uint", "r32sint", "r32float", "rg16uint", "rg16sint", "rg16float", "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb", "rgb9e5ufloat", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float", "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float", "stencil8", "depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8", "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb", "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm", "astc-4x4-unorm", "astc-4x4-unorm-srgb", "astc-5x4-unorm", "astc-5x4-unorm-srgb", "astc-5x5-unorm", "astc-5x5-unorm-srgb", "astc-6x5-unorm", "astc-6x5-unorm-srgb", "astc-6x6-unorm", "astc-6x6-unorm-srgb", "astc-8x5-unorm", "astc-8x5-unorm-srgb", "astc-8x6-unorm", "astc-8x6-unorm-srgb", "astc-8x8-unorm", "astc-8x8-unorm-srgb", "astc-10x5-unorm", "astc-10x5-unorm-srgb", "astc-10x6-unorm", "astc-10x6-unorm-srgb", "astc-10x8-unorm", "astc-10x8-unorm-srgb", "astc-10x10-unorm", "astc-10x10-unorm-srgb", "astc-12x10-unorm", "astc-12x10-unorm-srgb", "astc-12x12-unorm", "astc-12x12-unorm-srgb"];


const __wbindgen_enum_GpuTextureSampleType = ["float", "unfilterable-float", "depth", "sint", "uint"];


const __wbindgen_enum_GpuTextureViewDimension = ["1d", "2d", "2d-array", "cube", "cube-array", "3d"];


const __wbindgen_enum_ReadableStreamReaderMode = ["byob"];


const __wbindgen_enum_ReadableStreamType = ["bytes"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const BrushAppFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brushapp_free(ptr, 1));
const BrushMessageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brushmessage_free(ptr, 1));
const BrushSplatBuffersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brushsplatbuffers_free(ptr, 1));
const BrushSplatsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brushsplats_free(ptr, 1));
const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr, 1));
const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr, 1));
const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr, 1));
const TrainingFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_training_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('brush_js_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
