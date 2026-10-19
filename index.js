/**
 * dsh-image-annotate — host half.
 *
 * Provides ONE local HTTP route the client half calls the moment the user aims
 * the tool:
 *
 *   POST /dsh-image-annotate/capture  ->  { ok, path, w, h, at }
 *
 * Why this lives on the host: a browser tab cannot read the screen, so the only
 * way to freeze "what the user was looking at when they clicked 请求修改" is to
 * let the Node side do an OS-level capture. Doing it at arm time means the
 * pixels are captured BEFORE the overlay paints, so the image is clean.
 *
 * The capture is a DPI-aware PowerShell grab (see CAPTURE_PS1): on a 200% scaled
 * display a DPI-unaware process only sees the top-left quarter of the desktop,
 * which is exactly the bug that made earlier crops land on the wrong pane.
 *
 * @module dsh-image-annotate
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The web server is OPTIONAL: `ctx.inject` (not a hard `inject` list) keeps the
// whole bundle alive even if a profile mounts no webServer — only the capture
// route goes away, and the client degrades to "agent screenshots on receipt".

const ROUTE = '/dsh-image-annotate/capture'
const SHOT_DIR = join(tmpdir(), 'dsh-image-annotate')

/**
 * DPI-aware full-desktop grab. `$args[0]` is the output PNG path; `$args[1]` is
 * a JSON sidecar receiving the measured desktop size, so the Node side gets the
 * real pixel dimensions without parsing stdout (pipes are restricted).
 */
const CAPTURE_PS1 = `
$ErrorActionPreference = 'Stop'
$out = $args[0]
$meta = $args[1]
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@ -ErrorAction SilentlyContinue
  [DshDpi]::SetProcessDPIAware() | Out-Null
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $json = '{"ok":true,"w":' + $b.Width + ',"h":' + $b.Height + ',"x":' + $b.X + ',"y":' + $b.Y + '}'
  [System.IO.File]::WriteAllText($meta, $json)
} catch {
  [System.IO.File]::WriteAllText($meta, '{"ok":false,"error":"' + ($_.Exception.Message -replace '"','') + '"}')
  exit 1
}
`

/** Write the helper script once. */
function ensureScript() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const ps1 = join(SHOT_DIR, 'capture.ps1')
  writeFileSync(ps1, CAPTURE_PS1, 'utf8')
  return ps1
}

/**
 * Run one capture.
 * @returns {Promise<{ok:boolean, path?:string, w?:number, h?:number, at?:number, error?:string}>}
 */
function capture() {
  return new Promise(function (resolve) {
    let ps1
    try {
      ps1 = ensureScript()
    } catch (e) {
      resolve({ ok: false, error: 'script: ' + String(e && e.message ? e.message : e) })
      return
    }
    const stamp = Date.now()
    const png = join(SHOT_DIR, 'shot-' + stamp + '.png')
    const meta = join(SHOT_DIR, 'shot-' + stamp + '.json')
    const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    let child
    try {
      child = spawn(
        ps,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, png, meta],
        { stdio: 'ignore', windowsHide: true }
      )
    } catch (e) {
      resolve({ ok: false, error: 'spawn: ' + String(e && e.message ? e.message : e) })
      return
    }
    const finish = function (code) {
      try {
        const j = JSON.parse(readFileSync(meta, 'utf8'))
        if (j && j.ok) resolve({ ok: true, path: png, w: j.w, h: j.h, at: stamp })
        else resolve({ ok: false, error: (j && j.error) || 'capture failed' })
      } catch (_) {
        resolve({ ok: false, error: 'no meta (exit ' + code + ')' })
      }
    }
    child.on('exit', finish)
    child.on('error', function (e) {
      resolve({ ok: false, error: 'child: ' + String(e && e.message ? e.message : e) })
    })
  })
}

/**
 * Mount the capture route.
 *
 * @param {unknown} ctx - host cordis context (provides `webServer`).
 * @param {unknown} _config - row config.
 */
export function apply(ctx, _config) {
  ctx.inject(['webServer'], function (webCtx) {
    mount(webCtx)
  })
}

/**
 * Mount the route on a context that definitely has `webServer`.
 * @param {unknown} ctx - context with the webServer service.
 */
function mount(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async function (req, res) {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      // Drain the body so the socket stays reusable.
      try {
        req.resume()
        await new Promise(function (r) {
          req.on('end', r)
          req.on('error', r)
        })
      } catch (_) {
        /* ignore */
      }
      const result = await capture()
      res.statusCode = result.ok ? 200 : 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(result))
    },
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(function () {
      return dispose
    })
  }
}
