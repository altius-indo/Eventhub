declare module "heic-decode" {
  type Decoded = { width: number; height: number; data: Uint8ClampedArray };
  type Lazy = { width: number; height: number; decode: () => Promise<Decoded> };
  function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>;
  namespace decode {
    function all(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Lazy[] & { dispose: () => void }>;
  }
  export default decode;
}
