/**
 * CameraDriver — the interface the job runner drives, and a FakeReolink that implements it for
 * tests. A real driver (Baichuan discovery + login, the CGI Set/Get commands, ModifyUser) replaces
 * FakeReolink on hardware; the Dart bridge ports both this interface and the real driver from the
 * existing conformance-tested `lotiq_provision` core.
 *
 * The interface, deliberately small (mirrors doc 02 §2.11's CameraDriver):
 *   login(candidatePasswords) -> the password that worked, or throws (lockout budget lives here)
 *   setAdminPassword(oldPw, newPw) -> void   (ModifyUser; trap 4: only old+new works)
 *   apply(cmd, param) -> void                (a CGI Set command)
 *   readBack(verifyCmd, verifyParam) -> value (a CGI Get command, with the camera's field masking)
 */

/**
 * A Reolink stand-in that behaves like the real firmware in the ways that matter for the runner:
 * blank password on a factory unit, ModifyUser needing old+new (a bare `password` is ignored —
 * trap 4), and user/password fields masked on read (so the masked compare is exercised). It stores
 * whatever is applied and returns it under the matching Get key, so a correct apply reads back clean.
 */
export class FakeReolink {
  /** @param {{ uid: string, model?: string, firmware?: string, initialPassword?: string, ignoreFtpMode?: boolean }} opts */
  constructor({ uid, model = "RLC-1224A", firmware = "v3.2.0.5170_2510296888", initialPassword = "", ignoreFtpMode = false }) {
    this.uid = uid;
    this.model = model;
    this.firmware = firmware;
    this.password = initialPassword; // "" = factory-fresh blank
    this.loginAttempts = 0;
    this.locked = false;
    this.store = {}; // verifyKey -> value
    // When true, models the "SetFtpV20 saves but mode stays 0" silent-failure trap so a test can
    // prove the read-back diff actually catches it.
    this.ignoreFtpMode = ignoreFtpMode;
  }

  _verifyKeyFor(cmd) {
    return cmd.startsWith("Set") ? `Get${cmd.slice(3)}` : cmd;
  }

  async login(candidatePasswords) {
    for (const pw of candidatePasswords) {
      if (this.locked) throw new Error("camera locked (too many failed logins)");
      this.loginAttempts += 1;
      if (pw === this.password) return pw;
      if (this.loginAttempts >= 10) this.locked = true;
    }
    throw new Error("no candidate password worked");
  }

  async setAdminPassword(oldPw, newPw) {
    if (oldPw !== this.password) throw new Error("ModifyUser: oldPassword does not match");
    if (!newPw || newPw.length < 6) throw new Error("ModifyUser: newPassword rejected");
    this.password = newPw;
  }

  async apply(cmd, param) {
    const key = this._verifyKeyFor(cmd);
    // Deep clone so later mutations of the source don't change what we "stored".
    const stored = JSON.parse(JSON.stringify(param ?? {}));
    if (cmd === "SetFtpV20" && this.ignoreFtpMode && stored.Ftp) stored.Ftp.mode = 0; // the trap
    this.store[key] = stored;
  }

  async readBack(verifyCmd, _verifyParam) {
    const raw = this.store[verifyCmd];
    if (raw === undefined) return {};
    const v = JSON.parse(JSON.stringify(raw));
    // Model the field masking: userName/password on FTP and Email come back starred in the middle.
    for (const block of ["Ftp", "Email"]) {
      if (v[block] && typeof v[block] === "object") {
        if (typeof v[block].userName === "string") v[block].userName = maskMiddle(v[block].userName);
        if (typeof v[block].password === "string") v[block].password = "*".repeat(Math.max(4, v[block].password.length));
      }
    }
    return v;
  }
}

function maskMiddle(s) {
  if (s.length <= 2) return s;
  return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}
