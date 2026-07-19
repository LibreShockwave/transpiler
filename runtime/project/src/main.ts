import { Application, Sprite, Texture } from "pixi.js";

import * as runtime from "./runtime/index.js";
import { AudioPlayer } from "./runtime/AudioPlayer.js";
import { decodeRgbaToBitmap } from "./runtime/RgbaAsset.js";
import {
  buildFrameSnapshot,
  type CastJson,
  type ScoreBehaviorJson,
  type ScoreJson,
} from "./runtime/ScoreData.js";
import { ScorePlayer } from "./runtime/ScorePlayer.js";
import { renderFrame } from "./runtime/SoftwareFrameRenderer.js";
import { LingoRuntimeHost, setLingoHost } from "./runtime/index.js";
import { setNetworkBaseUrl, setPreloadedCastFiles } from "./runtime/network.js";

interface Manifest {
  runtimeVersion: string;
  stage: { width: number; height: number; backgroundColor: number };
  scripts?: Array<{ file: string }>;
  castlibs?: Array<{ number: number; name: string; fileName: string; file: string }>;
}

interface ScriptModule {
  lsScriptName: string;
  lsScriptType: string;
  lsCastLib: number;
  lsCastMember: number;
  lsLingoSource: string;
  lsHandlers: Array<{ name: string; args: string[]; event: string | null }>;
  lsHandlerStubs: Record<string, (...args: unknown[]) => runtime.LingoValue | void>;
}

interface CastlibModule {
  lsCastLib: number;
  lsCastLibName: string;
  lsMembers: Array<{
    id: number;
    name: string;
    type: string;
    text?: string;
    bakedBitmapAsset?: string;
    bakedWidth?: number;
    bakedHeight?: number;
  }>;
  lsScripts: Array<{ name: string; castMember: number; file: string }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

void (async () => {
  const manifest = await fetchJson<Manifest>("/manifest.json");
  const score = await fetchJson<ScoreJson>("/score.json");
  const cast = await fetchJson<CastJson>("/cast.json");
  const bitmaps = new Map<string, ReturnType<typeof decodeRgbaToBitmap>>();
  const loadBitmapAsset = async (
    asset: string | null | undefined,
    width: number | undefined,
    height: number | undefined,
  ): Promise<void> => {
    if (!asset || bitmaps.has(asset) || !width || !height) return;
    bitmaps.set(asset, decodeRgbaToBitmap(await fetchBytes(`/${asset}`), width, height));
  };

  for (const frame of score.frames) {
    for (const sprite of frame.sprites) {
      await loadBitmapAsset(sprite.bakedBitmapAsset, sprite.bakedWidth, sprite.bakedHeight);
    }
  }
  for (const member of cast.members ?? []) {
    await loadBitmapAsset(member.bakedBitmapAsset, member.bakedWidth, member.bakedHeight);
  }

  const firstFrame = score.frames[0];
  if (!firstFrame) throw new Error("Exported score contains no frames");

  for (const [name, value] of Object.entries(runtime)) {
    // Window.length is the child-frame count, but emitted Lingo uses bare
    // `length(value)` calls. The Window property is configurable in browsers,
    // and the exported player does not use frames, so install Director's
    // builtin here. Other browser globals (notably performance) must remain
    // intact and are handled through script dispatch instead.
    if (!(name in globalThis) || name === "length") {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
  }

  const player = new ScorePlayer(score);
  const audio = new AudioPlayer(cast.sounds ?? []);
  const host = new LingoRuntimeHost({
    score,
    cast,
    player,
    audio,
    loadBitmap: (asset) => bitmaps.get(asset) ?? null,
  });
  setLingoHost(host);
  (globalThis as unknown as { __lsLingoHost?: LingoRuntimeHost }).__lsLingoHost = host;
  (globalThis as unknown as Record<string, unknown>)._movie = host.getGlobal("_movie");
  (globalThis as unknown as Record<string, unknown>)._player = host.getGlobal("_player");

  const params = new URLSearchParams(window.location.search);
  const baseUrl = params.get("__lsBaseUrl") ?? `${window.location.origin}/`;
  setNetworkBaseUrl(baseUrl);
  host.setThe("moviePath", baseUrl);
  const playerObject = host.getGlobal("_player") as unknown as {
    externalParams: { add: (key: string, value: string) => void };
  };
  for (let index = 1; index <= 9; index += 1) {
    const key = `sw${index}`;
    const value = params.get(key);
    if (value !== null) playerObject.externalParams.add(key, value);
  }

  if (manifest.runtimeVersion !== runtime.RUNTIME_VERSION) {
    console.warn(
      `Runtime version mismatch: manifest=${manifest.runtimeVersion} runtime=${runtime.RUNTIME_VERSION}`,
    );
  }

  const scriptsByName = new Map<string, ScriptModule>();
  const scriptsByCastMember = new Map<string, ScriptModule>();
  for (const scriptInfo of manifest.scripts ?? []) {
    const module = (await import(/* @vite-ignore */ `/${scriptInfo.file}`)) as ScriptModule;
    scriptsByName.set(module.lsScriptName, module);
    scriptsByCastMember.set(`${module.lsCastLib}:${module.lsCastMember}`, module);
  }

  for (const castlibInfo of manifest.castlibs ?? []) {
    const module = (await import(/* @vite-ignore */ `/${castlibInfo.file}`)) as CastlibModule;
    for (const member of module.lsMembers) {
      await loadBitmapAsset(member.bakedBitmapAsset, member.bakedWidth, member.bakedHeight);
    }
    const members = new Map(
      module.lsMembers.map((member) => [
        member.id,
        {
          ...member,
          castLib: module.lsCastLib,
          bakedBitmapAsset: member.bakedBitmapAsset ?? null,
          bakedWidth: member.bakedWidth ?? 0,
          bakedHeight: member.bakedHeight ?? 0,
        },
      ]),
    );
    host.registerCastlib({
      number: module.lsCastLib,
      name: module.lsCastLibName || castlibInfo.name,
      fileName: castlibInfo.fileName,
      members,
      membersByName: new Map(module.lsMembers.map((member) => [member.name, member.id])),
      scriptsByName: new Map(module.lsScripts.map((script) => [script.name, script.castMember])),
      scriptsByCastMember: new Map(module.lsScripts.map((script) => [script.castMember, script.name])),
    });
  }
  setPreloadedCastFiles(
    (manifest.castlibs ?? []).flatMap((castlib) => [
      castlib.fileName,
      `${castlib.name}.cct`,
      `${castlib.name}.cst`,
    ]),
  );

  const resolveScriptToken = (token: string): string | null => {
    const match = token.match(/^script\("(.+)"\)$/);
    return match?.[1] ?? null;
  };
  const parentInstances = new Set<runtime.LingoMe>();
  const invokeInstance = (
    module: ScriptModule,
    handlerName: string,
    me: runtime.LingoMe,
    args: runtime.LingoValue[],
  ): runtime.LingoValue => {
    const implementation = module.lsHandlerStubs[handlerName];
    if (!implementation) return undefined;
    host.pushParams(args);
    host.pushCastLib(module.lsCastLib);
    try {
      return implementation(me, ...args) as runtime.LingoValue;
    } finally {
      host.popCastLib();
      host.popParams();
    }
  };

  host.setScriptInstanceCreator((token, args) => {
    const scriptName = resolveScriptToken(token);
    if (!scriptName) return undefined;
    const module = scriptsByName.get(scriptName);
    if (!module) return undefined;
    const me = host.createMe(0);
    me.props.set("__scriptName", scriptName);
    runtime.seedScriptProps(me, module.lsLingoSource);
    parentInstances.add(me);
    if (module.lsHandlers.some((handler) => handler.name === "_new")) {
      invokeInstance(module, "_new", me, args);
    }
    return me;
  });
  host.setInstanceDispatcher((scriptName, handlerName, me, args) => {
    let current: runtime.LingoValue = me;
    const visited = new Set<runtime.LingoMe>();
    while (current && typeof current === "object" && "props" in current) {
      const layer = current as runtime.LingoMe;
      if (visited.has(layer)) break;
      visited.add(layer);
      const layerScriptName = String(layer.props.get("__scriptName") ?? scriptName);
      const module = scriptsByName.get(layerScriptName);
      const handler = module?.lsHandlers.find(
        (candidate) => candidate.name.toLowerCase() === handlerName.toLowerCase(),
      );
      if (module && handler) {
        // Director sends inherited handlers to the composed leaf instance, so
        // property reads/writes continue to see the complete ancestor chain.
        return invokeInstance(module, handler.name, me, args);
      }
      current = layer.props.get("ancestor");
    }
    return undefined;
  });
  host.setInstanceHandlerChecker((scriptName, handlerName) =>
    scriptsByName.get(scriptName)?.lsHandlers.some(
      (handler) => handler.name.toLowerCase() === handlerName.toLowerCase(),
    ) ?? false
  );

  const behaviorInstances = new Map<string, runtime.LingoMe>();
  const movieInstances = new Map<string, runtime.LingoMe>();
  const behaviorKey = (behavior: ScoreBehaviorJson): string =>
    `${behavior.channel}:${behavior.castLib}:${behavior.castMember}`;
  const moduleForBehavior = (behavior: ScoreBehaviorJson): ScriptModule | undefined =>
    scriptsByCastMember.get(`${behavior.castLib}:${behavior.castMember}`);
  const instanceFor = (
    module: ScriptModule,
    spriteNum: number,
    cache: Map<string, runtime.LingoMe>,
    key: string,
  ): runtime.LingoMe => {
    let me = cache.get(key);
    if (!me) {
      me = host.createMe(spriteNum);
      me.props.set("__scriptName", module.lsScriptName);
      runtime.seedScriptProps(me, module.lsLingoSource);
      cache.set(key, me);
    }
    return me;
  };
  const dispatchModuleEvent = (
    module: ScriptModule,
    event: string,
    me: runtime.LingoMe,
    args: runtime.LingoValue[] = [],
  ): runtime.LingoValue => {
    const handler = module.lsHandlers.find((candidate) => candidate.event === event);
    return handler ? invokeInstance(module, handler.name, me, args) : undefined;
  };
  const dispatchBehavior = (behavior: ScoreBehaviorJson, event: string): void => {
    const module = moduleForBehavior(behavior);
    if (!module) return;
    const me = instanceFor(module, behavior.channel, behaviorInstances, behaviorKey(behavior));
    dispatchModuleEvent(module, event, me);
  };
  const dispatchMovieScripts = (event: string): void => {
    for (const module of scriptsByName.values()) {
      if (module.lsScriptType !== "MovieScript") continue;
      const me = instanceFor(module, 0, movieInstances, module.lsScriptName);
      dispatchModuleEvent(module, event, me);
    }
  };
  const dispatchParentInstances = (event: string): void => {
    // Director adds instances created with script(...).new() to the actor list.
    // Parent-script frame handlers (most importantly Object Manager's
    // prepareFrame pump) therefore receive the normal movie event cycle.
    for (const me of [...parentInstances]) {
      const scriptName = String(me.props.get("__scriptName") ?? "");
      const module = scriptsByName.get(scriptName);
      if (module) dispatchModuleEvent(module, event, me);
    }
  };

  // Bare Lingo calls resolve to MovieScript/global handlers, not same-named Parent
  // methods. Parent handlers are dispatched only through their script instances.
  const globalHandlerOwners = new Map<
    string,
    { module: ScriptModule; handler: ScriptModule["lsHandlers"][number] }
  >();
  for (const module of scriptsByName.values()) {
    for (const handler of module.lsHandlers) {
      const current = globalHandlerOwners.get(handler.name);
      if (!current || (
        module.lsScriptType === "MovieScript"
        && current.module.lsScriptType !== "MovieScript"
      )) {
        globalHandlerOwners.set(handler.name, { module, handler });
      }
    }
  }
  for (const [name, owner] of globalHandlerOwners) {
    if (name in globalThis) continue;
    (globalThis as unknown as Record<string, unknown>)[name] = (...args: runtime.LingoValue[]) => {
      const me = instanceFor(
        owner.module,
        0,
        movieInstances,
        `global:${owner.module.lsScriptName}`,
      );
      return invokeInstance(owner.module, owner.handler.name, me, args);
    };
  }

  let frameIndex = 0;
  let activeBehaviors = new Map<string, ScoreBehaviorJson>();
  const dispatchFrame = (event: string): void => {
    const frame = score.frames[frameIndex];
    if (!frame) return;
    for (const behavior of frame.behaviors ?? []) dispatchBehavior(behavior, event);
    if (frame.frameScript) {
      const module = moduleForBehavior(frame.frameScript);
      if (module) {
        const me = host.createMe(0);
        me.props.set("__scriptName", module.lsScriptName);
        runtime.seedScriptProps(me, module.lsLingoSource);
        dispatchModuleEvent(module, event, me);
      }
    }
    dispatchMovieScripts(event);
    dispatchParentInstances(event);
  };
  const updateBehaviorActivation = (): void => {
    const next = new Map<string, ScoreBehaviorJson>();
    for (const behavior of score.frames[frameIndex]?.behaviors ?? []) {
      const key = behaviorKey(behavior);
      next.set(key, behavior);
      if (!activeBehaviors.has(key)) dispatchBehavior(behavior, "beginSprite");
    }
    for (const [key, behavior] of activeBehaviors) {
      if (!next.has(key)) dispatchBehavior(behavior, "endSprite");
    }
    activeBehaviors = next;
  };

  host.setSpriteDispatcher((channel, handlerName, args) => {
    const behavior = score.frames[frameIndex]?.behaviors?.find(
      (candidate) => candidate.channel === channel,
    );
    if (!behavior) return undefined;
    const module = moduleForBehavior(behavior);
    if (!module) return undefined;
    const me = instanceFor(module, channel, behaviorInstances, behaviorKey(behavior));
    return invokeInstance(module, handlerName, me, args);
  });

  const canvas = document.createElement("canvas");
  canvas.width = score.stageWidth;
  canvas.height = score.stageHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create stage canvas");
  const app = new Application();
  await app.init({ width: score.stageWidth, height: score.stageHeight, antialias: false });
  const texture = Texture.from(canvas);
  app.stage.addChild(new Sprite(texture));
  document.getElementById("stage-host")?.appendChild(app.canvas);

  let currentSnapshot: runtime.FrameSnapshot | null = null;
  let previousScoreSnapshot: runtime.FrameSnapshot | null = null;
  let bakeTick = 0;
  const hydrateCurrentFrame = (): void => {
    const scoreSnapshot = buildFrameSnapshot(
      score,
      cast,
      frameIndex,
      (asset) => bitmaps.get(asset) ?? null,
      bakeTick,
    );
    currentSnapshot = currentSnapshot && previousScoreSnapshot
      ? runtime.mergeScoreSnapshot(previousScoreSnapshot, currentSnapshot, scoreSnapshot)
      : runtime.cloneFrameSnapshot(scoreSnapshot);
    previousScoreSnapshot = runtime.cloneFrameSnapshot(scoreSnapshot);
    host.snapshot = currentSnapshot;
  };
  const renderCurrentFrame = (): void => {
    if (!currentSnapshot) return;
    const rendered = renderFrame(currentSnapshot, score.stageWidth, score.stageHeight);
    const pixels = rendered.pixels();
    const rgba = new Uint8ClampedArray(pixels.length * 4);
    for (let i = 0; i < pixels.length; i += 1) {
      const pixel = pixels[i] ?? 0;
      const offset = i * 4;
      rgba[offset] = (pixel >>> 16) & 0xff;
      rgba[offset + 1] = (pixel >>> 8) & 0xff;
      rgba[offset + 2] = pixel & 0xff;
      rgba[offset + 3] = (pixel >>> 24) & 0xff;
    }
    context.putImageData(new ImageData(rgba, score.stageWidth, score.stageHeight), 0, 0);
    texture.source.update();
  };

  dispatchMovieScripts("prepareMovie");
  hydrateCurrentFrame();
  updateBehaviorActivation();
  dispatchFrame("prepareFrame");
  dispatchMovieScripts("startMovie");
  dispatchFrame("enterFrame");
  dispatchFrame("exitFrame");
  renderCurrentFrame();

  let paused = params.has("__lsPaused");
  let previousTick = performance.now();
  const stepFrame = (): void => {
    dispatchFrame("stepFrame");
    dispatchFrame("prepareFrame");
    dispatchFrame("enterFrame");
    dispatchMovieScripts("idle");
    dispatchFrame("exitFrame");
    renderCurrentFrame();
    const override = host.applyFrameOverride(frameIndex);
    frameIndex = override ?? ((frameIndex + 1) % score.frames.length);
    bakeTick += 1;
    hydrateCurrentFrame();
    updateBehaviorActivation();
  };
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    if (paused || now - previousTick < player.frameDelayMs(frameIndex)) return;
    previousTick = now;
    stepFrame();
  };
  requestAnimationFrame(tick);

  let audioPrimed = false;
  const primeAudio = async (): Promise<void> => {
    if (audioPrimed) return;
    audioPrimed = true;
    await audio.audioContext.resume();
    await audio.preload();
  };
  const updatePointer = (event: PointerEvent): void => {
    const rect = app.canvas.getBoundingClientRect();
    host.setThe("mouseH", Math.floor((event.clientX - rect.left) * score.stageWidth / rect.width));
    host.setThe("mouseV", Math.floor((event.clientY - rect.top) * score.stageHeight / rect.height));
  };
  app.canvas.addEventListener("pointermove", updatePointer);
  app.canvas.addEventListener("pointerdown", (event) => {
    updatePointer(event);
    host.setThe("mouseDown", true);
    void primeAudio();
    dispatchFrame("mouseDown");
  });
  app.canvas.addEventListener("pointerup", (event) => {
    updatePointer(event);
    host.setThe("mouseDown", false);
    dispatchFrame("mouseUp");
  });
  document.addEventListener("keydown", (event) => {
    host.setThe("key", event.key);
    host.setThe("keyCode", event.keyCode);
    host.setThe("shiftDown", event.shiftKey);
    void primeAudio();
    dispatchFrame("keyDown");
  });
  document.addEventListener("keyup", (event) => {
    host.setThe("key", event.key);
    host.setThe("keyCode", event.keyCode);
    host.setThe("shiftDown", event.shiftKey);
    dispatchFrame("keyUp");
  });

  const harness = window as unknown as {
    __lsReady?: boolean;
    __lsStep?: () => void;
    __lsCapture?: () => Uint8ClampedArray;
    __lsFrameIndex?: () => number;
    __lsBakeTick?: () => number;
    __lsSetPaused?: (value: boolean) => void;
    __lsSprites?: () => runtime.RenderSprite[];
  };
  harness.__lsStep = stepFrame;
  harness.__lsCapture = () =>
    context.getImageData(0, 0, score.stageWidth, score.stageHeight).data;
  harness.__lsFrameIndex = () => frameIndex;
  harness.__lsBakeTick = () => bakeTick;
  harness.__lsSetPaused = (value) => { paused = value; };
  harness.__lsSprites = () => currentSnapshot?.sprites.map((sprite) => ({ ...sprite })) ?? [];
  harness.__lsReady = true;
})().catch((error: unknown) => {
  console.error(error);
  document.body.textContent = error instanceof Error ? error.message : String(error);
});
