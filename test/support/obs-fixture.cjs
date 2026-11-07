/** In-memory OBS protocol peer. Never connects to or changes a user's OBS. */
const crypto = require("node:crypto");
module.exports = function obsFixture() {
  const model = {
    password: "fixture OBS password",
    program: "Main",
    preview: "Break",
    collection: "Fixture",
    studio: true,
    streaming: false,
    recording: false,
    virtualCamera: false,
    requests: [],
    sockets: [],
    items: [
      { sourceName: "Camera", sceneItemId: 7, sceneItemEnabled: true, isGroup: false },
      { sourceName: "Graphics", sceneItemId: 9, sceneItemEnabled: true, isGroup: true },
    ],
    groupItems: [{ sourceName: "Logo", sceneItemId: 3, sceneItemEnabled: true, isGroup: false }],
    filters: [{ filterName: "Crop", filterEnabled: true }],
    muted: false,
    volume: 0.6,
    imageData: "data:image/jpg;base64,/9j/YWJj",
  };
  const methods = {
    GetVersion: () => ({
      availableRequests: Object.keys(methods),
      rpcVersion: 1,
      obsVersion: "32.0.0",
    }),
    GetSceneList: () => ({
      scenes: [{ sceneName: "Main" }, { sceneName: "Break" }],
      currentProgramSceneName: model.program,
      currentPreviewSceneName: model.preview,
    }),
    GetInputList: () => ({
      inputs: [
        { inputName: "Mic", inputKind: "wasapi_input_capture" },
        { inputName: "Camera", inputKind: "dshow_input" },
        { inputName: "Logo", inputKind: "image_source" },
      ],
    }),
    GetSceneCollectionList: () => ({
      currentSceneCollectionName: model.collection,
      sceneCollections: [model.collection],
    }),
    GetGroupList: () => ({ groups: ["Graphics"] }),
    GetSceneItemList: () => ({ sceneItems: model.items }),
    GetGroupSceneItemList: () => ({ sceneItems: model.groupItems }),
    GetStudioModeEnabled: () => ({ studioModeEnabled: model.studio }),
    GetSourceFilterList: (d) => ({ filters: d.sourceName === "Camera" ? model.filters : [] }),
    GetInputMute: (d) => {
      if (d.inputName !== "Mic") throw Error();
      return { inputMuted: model.muted };
    },
    GetInputVolume: (d) => {
      if (d.inputName !== "Mic") throw Error();
      return { inputVolumeMul: model.volume };
    },
    GetStreamStatus: () => ({ outputActive: model.streaming }),
    GetRecordStatus: () => ({ outputActive: model.recording }),
    GetVirtualCamStatus: () => ({ outputActive: model.virtualCamera }),
    GetReplayBufferStatus: () => ({ outputActive: true }),
    GetSceneTransitionList: () => ({
      transitions: [{ transitionName: "Fade" }, { transitionName: "Cut" }],
    }),
    GetCurrentSceneTransition: () => ({ transitionFixed: model.transition === "Cut" }),
    GetSourceScreenshot: () => ({ imageData: model.imageData }),
    SetCurrentProgramScene: (d) => {
      model.program = d.sceneName;
      model.emit("CurrentProgramSceneChanged", { sceneName: d.sceneName });
      return {};
    },
    SetCurrentPreviewScene: (d) => {
      model.preview = d.sceneName;
      model.emit("CurrentPreviewSceneChanged", { sceneName: d.sceneName });
      return {};
    },
    SetSceneItemEnabled: (d) => {
      const rows = d.sceneName === "Graphics" ? model.groupItems : model.items;
      const row = rows.find((r) => r.sceneItemId === d.sceneItemId);
      if (!row) throw Error();
      row.sceneItemEnabled = d.sceneItemEnabled;
      model.emit("SceneItemEnableStateChanged", d);
      return {};
    },
    SetInputMute: (d) => {
      model.muted = d.inputMuted;
      model.emit("InputMuteStateChanged", d);
      return {};
    },
    SetInputVolume: (d) => {
      model.volume = d.inputVolumeMul;
      model.emit("InputVolumeChanged", d);
      return {};
    },
    SetSourceFilterEnabled: (d) => {
      const row = model.filters.find((r) => r.filterName === d.filterName);
      if (!row) throw Error();
      row.filterEnabled = d.filterEnabled;
      model.emit("SourceFilterEnableStateChanged", d);
      return {};
    },
    SetStudioModeEnabled: (d) => {
      model.studio = d.studioModeEnabled;
      model.emit("StudioModeStateChanged", d);
      return {};
    },
    SetCurrentSceneTransition: (d) => {
      model.transition = d.transitionName;
      return {};
    },
    SetCurrentSceneTransitionDuration: () => ({}),
    TriggerStudioModeTransition: () => {
      model.program = model.preview;
      return {};
    },
    ToggleRecord: () => {
      model.recording = !model.recording;
      return {};
    },
    ToggleStream: () => {
      model.streaming = !model.streaming;
      return {};
    },
    ToggleVirtualCam: () => {
      model.virtualCamera = !model.virtualCamera;
      return {};
    },
    SaveReplayBuffer: () => ({}),
  };
  class Socket extends EventTarget {
    constructor(url, protocol) {
      super();
      this.url = url;
      this.protocol = protocol;
      this.closed = false;
      model.sockets.push(this);
      queueMicrotask(() =>
        this.deliver({
          op: 0,
          d: {
            rpcVersion: 1,
            authentication: { salt: "fixture-salt", challenge: "fixture-challenge" },
          },
        }),
      );
    }
    deliver(data) {
      if (!this.closed)
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.op === 1) {
        const secret = crypto
          .createHash("sha256")
          .update(model.password + "fixture-salt")
          .digest("base64");
        const expected = crypto
          .createHash("sha256")
          .update(secret + "fixture-challenge")
          .digest("base64");
        if (message.d.authentication !== expected) {
          this.close(4009);
          return;
        }
        model.identify = message.d;
        queueMicrotask(() => this.deliver({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      const d = message.d;
      model.requests.push({ type: d.requestType, data: structuredClone(d.requestData) });
      let data,
        ok = true;
      try {
        if (model.rejectNext === d.requestType) {
          model.rejectNext = null;
          throw Error();
        }
        data = methods[d.requestType](d.requestData);
      } catch {
        ok = false;
      }
      if (model.dropNext === d.requestType) {
        model.dropNext = null;
        this.close(1006);
        return;
      }
      queueMicrotask(() =>
        this.deliver({
          op: 7,
          d: {
            requestType: d.requestType,
            requestId: d.requestId,
            requestStatus: { result: ok, code: ok ? 100 : 600 },
            responseData: data || {},
          },
        }),
      );
    }
    close(code = 1000) {
      if (this.closed) return;
      this.closed = true;
      const event = new Event("close");
      event.code = code;
      queueMicrotask(() => this.dispatchEvent(event));
    }
  }
  model.emit = (eventType, eventData) => {
    for (const socket of model.sockets) socket.deliver({ op: 5, d: { eventType, eventData } });
  };
  model.WebSocketImpl = Socket;
  // This codec is test-only. Production always uses the Windows DPAPI adapter.
  model.codec = {
    protectTextMapWithWindowsDpapi: (values) => ({
      ok: true,
      encrypted: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, "fixture:" + Buffer.from(v).toString("base64")]),
      ),
    }),
    unprotectTextMapWithWindowsDpapi: (values) => ({
      ok: true,
      plain: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, Buffer.from(v.slice(8), "base64").toString()]),
      ),
    }),
  };
  model.writes = () => model.requests.filter((r) => !/^(Get)/.test(r.type));
  return model;
};
