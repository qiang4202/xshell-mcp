// Functional harness: runs the REAL bridge.js inside the JScript engine with a
// stubbed Xshell host, feeds it one request file, and dumps the response.
//
// argv: <bridgePath> <rootDir> <sessionId> <requestFile> <responseDir>
// NOTE: this file is JScript -- no trailing commas, no ES6.
var fso = new ActiveXObject("Scripting.FileSystemObject");

var bridgePath = WScript.Arguments(0);
var rootDir = WScript.Arguments(1);
var sessionId = WScript.Arguments(2);
var requestFile = WScript.Arguments(3);
var responseDir = WScript.Arguments(4);

var screenBuffer = "";
var sentPayloads = [];
var sleepCount = 0;
var ctrlCCount = 0;
var CTRL_C_CHAR = String.fromCharCode(3);
var throwSleeps = WScript.Arguments.length > 5 ? Number(WScript.Arguments(5)) : 0;
var MAX_SLEEPS = 2000;
var requestWritten = false;
var loopCapHit = false;
var QUIT_REQUESTED = false;
var responsePath = responseDir + "\\probe.json";
var requestsDir = responseDir.replace(/responses$/, "requests");

function echoLine(text) {
  WScript.Echo(text);
}

var xsh = {
  Screen: {
    CurrentRow: 1,
    Send: function (text) {
      var payload = String(text);
      sentPayloads.push(payload);
      if (payload.indexOf(CTRL_C_CHAR) >= 0) {
        ctrlCCount = ctrlCCount + 1;
      }
      // Commands containing SUPPRESS_ECHO simulate output that never reaches the
      // screen, which is how a completion-marker timeout is exercised.
      if (payload.indexOf("SUPPRESS_ECHO") >= 0) {
        return;
      }
      screenBuffer = screenBuffer + payload + "\r\n";
    },
    Get: function (row1, col1, row2, col2) {
      // return the buffer once, on the first row only
      return row1 === 1 ? screenBuffer : "";
    }
  },
  Session: {
    Sleep: function (ms) {
      sleepCount = sleepCount + 1;
      // Optionally prove the loop survives a throwing sleep (regression guard:
      // an unguarded sleep used to end the whole script).
      if (sleepCount <= throwSleeps) {
        throw "SIMULATED_SLEEP_FAILURE";
      }
      // clearPendingRequests() has already run by the first sleep, so it is safe
      // to drop the request in now.
      if (!requestWritten) {
        requestWritten = true;
        var src = fso.OpenTextFile(requestFile, 1, false, 0);
        var body = src.ReadAll();
        src.Close();
        var dst = fso.OpenTextFile(requestsDir + "\\probe.json", 2, true, 0);
        dst.Write(body);
        dst.Close();
        return;
      }
      // Stop as soon as the bridge has produced its answer. The bridge absorbs
      // every exception now, so the only way out is its own exit flag.
      if (fso.FileExists(responsePath)) {
        QUIT_REQUESTED = true;
        return;
      }
      if (sleepCount > 2000) {
        loopCapHit = true;
        QUIT_REQUESTED = true;
        return;
      }
      // Really wait, so waitForText's deadline advances with wall-clock time
      // instead of spinning the loop until the safety cap.
      try {
        WScript.Sleep(ms > 250 ? 250 : ms);
      } catch (eSleep) {
      }
    }
  },
  Dialog: {
    MsgBox: function (text) {
      // recorded but never shown
      return 1;
    }
  }
};

var SESSION_ID = sessionId;
var BRIDGE_ROOT_DIR_OVERRIDE = rootDir;
var CONFIG_PATH_OVERRIDE = rootDir + "\\nonexistent-config.json";

var source = null;
try {
  var f = fso.OpenTextFile(bridgePath, 1, false, 0);
  source = f.ReadAll();
  f.Close();
} catch (eRead) {
  echoLine("LOAD_ERROR: " + (eRead.message || String(eRead)));
  WScript.Quit(3);
}

try {
  eval(source);
} catch (eRun) {
  echoLine("RUN_ERROR: " + (eRun && eRun.message ? eRun.message : String(eRun)));
  WScript.Quit(4);
}

// Collect the response the bridge wrote.
if (!fso.FileExists(responsePath)) {
  echoLine("NO_RESPONSE");
  WScript.Quit(5);
}

var r = fso.OpenTextFile(responsePath, 1, false, -1);
var payload = r.ReadAll();
r.Close();

echoLine("RESPONSE_BEGIN");
echoLine(payload);
echoLine("RESPONSE_END");
echoLine("SLEEPS=" + sleepCount);
echoLine("CTRLC=" + ctrlCCount);
echoLine("LOOPCAP=" + (loopCapHit ? "1" : "0"));
echoLine("SENT_BEGIN");
for (var i = 0; i < sentPayloads.length; i = i + 1) {
  echoLine("SENT[" + i + "]=" + sentPayloads[i].replace(/\r/g, "<CR>").replace(/\n/g, "<LF>"));
}
echoLine("SENT_END");
