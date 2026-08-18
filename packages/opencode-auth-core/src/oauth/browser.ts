import { spawn } from "node:child_process";

export async function openExternalUrl(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let command: string;
    let args: string[];

    if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
