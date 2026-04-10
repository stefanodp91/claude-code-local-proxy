import { Injectable } from "@angular/core";

interface VsCodeApi {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

@Injectable({ providedIn: "root" })
export class VscodeApiService {
  private readonly api: VsCodeApi;

  constructor() {
    this.api = acquireVsCodeApi();
  }

  postMessage(message: any): void {
    this.api.postMessage(message);
  }

  getState<T>(): T | undefined {
    return this.api.getState() as T | undefined;
  }

  setState<T>(state: T): void {
    this.api.setState(state);
  }
}
