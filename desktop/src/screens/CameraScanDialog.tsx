import { useCallback, useEffect, useRef, useState } from "react";
import { decodeQrFrame, Icon, isOtpUri, scanProgress } from "@auth/ui";
import { api } from "../api";

interface Props {
  onCancel: () => void;
  /** Các link OTP đọc được (đã bỏ trùng), theo thứ tự quét. */
  onDone: (uris: string[]) => void;
}

/** Khoảng cách giữa hai lần đọc khung hình. */
const SCAN_INTERVAL_MS = 150;
/** Thu nhỏ khung hình về cạnh dài tối đa này trước khi đọc QR, để đủ nhanh. */
const MAX_FRAME_SIDE = 960;
/** Cứ mấy khung thì thử thêm QR đảo màu (điện thoại ở chế độ tối) một lần. */
const INVERT_EVERY = 3;
/** Quét đủ thì chờ một chút cho người dùng thấy "đã đủ" rồi mới đóng. */
const FINISH_DELAY_MS = 700;

type Status =
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "error"; message: string };

function cameraError(e: unknown): string {
  switch (e instanceof DOMException ? e.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Không được phép dùng webcam. Hãy bấm Cho phép khi được hỏi, và kiểm tra " +
        "Windows Settings → Privacy & security → Camera đã bật " +
        "“Let desktop apps access your camera”."
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return "Không tìm thấy webcam.";
    case "NotReadableError":
    case "AbortError":
      return "Không mở được webcam, có thể ứng dụng khác (Zoom, Teams...) đang dùng.";
    default:
      return `Không mở được webcam: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function describeProgress(uris: string[]): string {
  const { batches, plain, complete } = scanProgress(uris);
  if (plain === 0 && batches.length === 1) {
    const { scanned, size } = batches[0];
    if (size > 1) {
      return complete
        ? `Đã đọc đủ ${size}/${size} QR.`
        : `Đã đọc ${scanned}/${size} QR. Bấm “Tiếp” trên điện thoại để hiện QR sau.`;
    }
  }
  return `Đã đọc ${uris.length} mã QR.`;
}

/**
 * Quét QR bằng webcam: đọc liên tục, gom mọi mã 2FA khác nhau. Export của Google Authenticator
 * có thể gồm nhiều QR (1/3, 2/3...): quét đủ cả lô thì tự đóng; link `otpauth://` thường thì
 * đọc được một mã là xong.
 */
export function CameraScanDialog({ onCancel, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "starting" });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  /** Webcam người dùng chọn; "" = mặc định của hệ thống. */
  const [deviceId, setDeviceId] = useState("");
  /** Webcam đang mở thật (để hiện trong ô chọn). */
  const [activeDevice, setActiveDevice] = useState("");
  const [uris, setUris] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const urisRef = useRef<string[]>([]);
  const finished = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Giữ callback mới nhất mà không phải mở lại webcam mỗi lần component cha render.
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;

  const finish = useCallback(() => {
    if (finished.current || urisRef.current.length === 0) return;
    finished.current = true;
    clearTimeout(finishTimer.current);
    onDoneRef.current(urisRef.current);
  }, []);

  const found = useCallback(
    (raw: string) => {
      if (finished.current) return;
      const text = raw.trim();
      if (!isOtpUri(text)) {
        setNotice("QR vừa thấy không phải mã 2FA (otpauth://).");
        return;
      }
      if (urisRef.current.includes(text)) return;
      const next = [...urisRef.current, text];
      urisRef.current = next;
      setUris(next);
      setNotice(null);
      if (scanProgress(next).complete && finishTimer.current === undefined) {
        finishTimer.current = setTimeout(finish, FINISH_DELAY_MS);
      }
    },
    [finish],
  );

  useEffect(() => () => clearTimeout(finishTimer.current), []);

  // Cửa sổ đóng xuống tray: đóng luôn hộp thoại để tắt webcam.
  useEffect(() => {
    const unlisten = api.onWindowHidden(() => onCancelRef.current());
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    const release = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      if (ctx && video && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.drawImage(video, 0, 0, width, height);
        const inverted = frame++ % INVERT_EVERY === INVERT_EVERY - 1;
        const text = decodeQrFrame(ctx.getImageData(0, 0, width, height), inverted);
        if (text) found(text);
      }
      timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };

    const start = async () => {
      setStatus({ kind: "starting" });
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("WebView không hỗ trợ camera.");
        }
        const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceId ? { ...size, deviceId: { exact: deviceId } } : size,
        });
        // Hộp thoại đã đóng (hoặc đổi webcam) trong lúc chờ quyền: tắt ngay webcam vừa mở.
        const video = videoRef.current;
        if (stopped || !video) {
          release();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (stopped) return;
        setStatus({ kind: "scanning" });
        setActiveDevice(stream.getVideoTracks()[0]?.getSettings().deviceId ?? "");
        // Tên webcam chỉ có sau khi đã được cấp quyền, nên liệt kê sau getUserMedia.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!stopped) setDevices(all.filter((d) => d.kind === "videoinput"));
        tick();
      } catch (e) {
        release();
        if (!stopped) setStatus({ kind: "error", message: cameraError(e) });
      }
    };

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      release();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [deviceId, found]);

  const { complete } = scanProgress(uris);

  return (
    <div
      className="dialog-backdrop dialog-backdrop--top"
      onMouseDown={(e) => {
        // Không để lan lên nền của hộp thoại "Thêm tài khoản" (sẽ đóng luôn hộp thoại đó).
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="dialog dialog--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Quét QR bằng webcam</h2>

        <div className={status.kind === "error" ? "camera camera--off" : "camera"}>
          <video ref={videoRef} className="camera__video" muted playsInline />
          {status.kind === "starting" && (
            <div className="camera__overlay">
              <span className="spinner" />
              Đang mở webcam…
            </div>
          )}
          {status.kind === "scanning" && (
            <div className={complete ? "camera__frame camera__frame--done" : "camera__frame"} />
          )}
        </div>

        {status.kind === "error" ? (
          <p className="auth-error">{status.message}</p>
        ) : (
          <p className="auth-muted hint">
            Giơ màn hình điện thoại có QR trước webcam, giữ yên, cách khoảng 20–30 cm. Google
            Authenticator: <strong>Chuyển tài khoản → Xuất tài khoản</strong>; có nhiều QR thì
            bấm “Tiếp” trên điện thoại, app tự gom đủ.
          </p>
        )}

        {devices.length > 1 && (
          <select
            className="auth-input"
            value={activeDevice}
            onChange={(e) => setDeviceId(e.target.value)}
            title="Chọn webcam"
          >
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Webcam ${i + 1}`}
              </option>
            ))}
          </select>
        )}

        {uris.length > 0 && (
          <p className="camera__progress">
            <Icon name="check" /> {describeProgress(uris)}
          </p>
        )}
        {notice && <p className="auth-muted hint">{notice}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn" onClick={onCancel}>
            Huỷ
          </button>
          <button
            type="button"
            className="auth-btn auth-btn--primary"
            disabled={uris.length === 0}
            onClick={finish}
          >
            Xong{uris.length > 0 ? ` (${uris.length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
