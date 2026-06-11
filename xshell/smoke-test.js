// Minimal Xshell script parser/runtime smoke test.
var fso = new ActiveXObject("Scripting.FileSystemObject");
var dirPath = "C:\\Users\\80703\\Documents\\xshell-mcp-bridge\\smoke-test";
if (!fso.FolderExists("C:\\Users\\80703\\Documents\\xshell-mcp-bridge")) {
  fso.CreateFolder("C:\\Users\\80703\\Documents\\xshell-mcp-bridge");
}
if (!fso.FolderExists(dirPath)) {
  fso.CreateFolder(dirPath);
}
var file = fso.OpenTextFile(dirPath + "\\status.txt", 2, true, -1);
file.Write("ok");
file.Close();
xsh.Dialog.MsgBox("Smoke test ok.");

