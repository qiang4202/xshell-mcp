// Runs inside Windows Script Host (cscript /E:JScript).
// Parses the target file with the real JScript engine WITHOUT executing it.
// argv: <file> [format]   format: 0 = ASCII (default), -1 = Unicode
var fso = new ActiveXObject("Scripting.FileSystemObject");
var target = WScript.Arguments(0);
var format = WScript.Arguments.length > 1 ? Number(WScript.Arguments(1)) : 0;

if (!fso.FileExists(target)) {
  WScript.Echo("MISSING: " + target);
  WScript.Quit(2);
}

try {
  var file = fso.OpenTextFile(target, 1, false, format);
  var source = file.ReadAll();
  file.Close();

  // new Function() compiles the body; nothing runs.
  var compiled = new Function(source);
  if (typeof compiled !== "function") {
    WScript.Echo("PARSE_ERROR: unexpected compile result");
    WScript.Quit(1);
  }
  WScript.Echo("PARSE_OK");
} catch (e) {
  WScript.Echo("PARSE_ERROR: " + (e.message || String(e)));
  WScript.Quit(1);
}
