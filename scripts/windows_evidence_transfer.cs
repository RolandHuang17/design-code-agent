using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

// Guest-to-host evidence transport only; never reads credentials or executes files.
public static class EvidenceTransfer {
    [STAThread] public static void Main() {
        Application.EnableVisualStyles();
        var form = new Form { Text="Guest evidence transfer (local host only)", Width=850, Height=430 };
        var url = new TextBox { Left=20, Top=20, Width=790 };
        var config = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"transfer-url.txt");
        if(File.Exists(config)) url.Text=File.ReadAllText(config).Trim();
        var choose = new Button { Left=20, Top=65, Width=190, Text="Select evidence file" };
        var send = new Button { Left=230, Top=65, Width=190, Text="Upload selected file" };
        var packMain = new Button { Left=20, Top=105, Width=190, Text="Package main task evidence" };
        var packPrototype = new Button { Left=230, Top=105, Width=240, Text="Package prototype task evidence" };
        var result = new TextBox { Left=20, Top=150, Width=790, Height=205, Multiline=true, ReadOnly=true, ScrollBars=ScrollBars.Both };
        string selected=null;
        Action<string,string> package = (folder,label) => {
            try {
                var source=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),folder);
                if(!Directory.Exists(source)) { result.Text="Task directory absent: "+source; return; }
                var target=Path.Combine(Path.GetTempPath(),"DCA-"+label+"-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+".zip");
                ZipFile.CreateFromDirectory(source,target,CompressionLevel.Optimal,false);
                selected=target;
                result.Text="Packaged task evidence only: "+source+"\r\nSelected: "+selected+"\r\nClick Upload selected file to transfer to the local host.";
            } catch(Exception error) { result.Text=error.GetType().Name+": "+error.Message; }
        };
        packMain.Click += (sender,args) => package("DesignCodeAgent","main");
        packPrototype.Click += (sender,args) => package("DesignCodeAgent-Superagent","prototype");
        choose.Click += (sender,args) => {
            using(var dialog=new OpenFileDialog { Filter="Evidence (*.zip;*.txt;*.json)|*.zip;*.txt;*.json" }) {
                if(dialog.ShowDialog()==DialogResult.OK) { selected=dialog.FileName; result.Text="Selected: "+selected; }
            }
        };
        send.Click += async (sender,args) => {
            Uri destination;
            if(!Uri.TryCreate(url.Text,UriKind.Absolute,out destination) || destination.Scheme!="http" || destination.Host!="10.0.2.2" || destination.Port!=8766) {
                result.Text="Only the VM NAT host address http://10.0.2.2:8766 is allowed."; return;
            }
            if(selected==null) { result.Text="Select an evidence file first. Never select credentials."; return; }
            var info=new FileInfo(selected);
            if(!info.Exists || info.Length>64*1024*1024) { result.Text="File missing or exceeds64MB."; return; }
            send.Enabled=false; choose.Enabled=false;
            try {
                var file=selected;
                result.Text=await Task.Run(() => {
                    var request=(HttpWebRequest)WebRequest.Create(destination);
                    request.Proxy=null; request.Method="POST"; request.Timeout=30000; request.ReadWriteTimeout=30000;
                    request.ContentType="application/octet-stream";
                    request.Headers["X-Evidence-Name"]=Uri.EscapeDataString(Path.GetFileName(file));
                    request.ContentLength=new FileInfo(file).Length;
                    using(var input=File.OpenRead(file)) using(var output=request.GetRequestStream()) input.CopyTo(output);
                    using(var response=request.GetResponse()) using(var reader=new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
                });
            } catch(Exception error) { result.Text=error.GetType().Name+": "+error.Message; }
            finally { send.Enabled=true; choose.Enabled=true; }
        };
        form.Controls.AddRange(new Control[]{url,choose,send,packMain,packPrototype,result});
        Application.Run(form);
    }
}
