/// LotIQ provisioning bridge — public API.
///
/// Port of the Node reference in `../reference/lib`. The bridge pairs with the backend using a
/// 6-digit code, polls for jobs, runs each against a [CameraDriver], and reports progress + result.
library lotiq_bridge;

export 'src/backend_client.dart';
export 'src/camera_driver.dart';
export 'src/job_runner.dart';
export 'src/bridge.dart';
export 'src/readback.dart';
// The vendored, conformance-tested protocol core (from kunal-lotiq/lotiq-installer).
export 'src/vendor/baichuan_client.dart' show BaichuanClient, DeviceInfo, BaichuanAuthException;
export 'src/vendor/provisioner.dart' show Cgi, Discovery, Discovered, FindFailure, FindProblem;
