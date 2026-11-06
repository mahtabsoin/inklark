"""Optional local PDF decryption. Input and output use memory, never temp files."""
import base64
import io
import json
import sys


def fail(code, message):
    print(json.dumps({"ok": False, "code": code, "message": message}))


def main():
    try:
        import pikepdf
    except ImportError:
        fail("HELPER_UNAVAILABLE", "Local PDF support is not installed. Ask your agent to install requirements-pdf.txt.")
        return
    try:
        request = json.loads(sys.stdin.buffer.read(45 * 1024 * 1024 + 1))
        data = base64.b64decode(request["base64"], validate=True)
        password = request.get("password", "")
        if len(data) > 30 * 1024 * 1024 or not isinstance(password, str) or len(password) > 1000:
            fail("INVALID_INPUT", "Choose a PDF under 30 MB.")
            return
        with pikepdf.Pdf.open(io.BytesIO(data), password=password) as pdf:
            if len(pdf.pages) > 100:
                fail("PAGE_LIMIT", "Open a PDF with 100 pages or fewer.")
                return
            if "/Perms" in pdf.Root:
                fail("SIGNED_PDF", "This PDF has certification restrictions. Use an unsigned original.")
                return
            for obj in pdf.objects:
                if isinstance(obj, pikepdf.Dictionary):
                    if "/ByteRange" in obj or str(obj.get("/Type", "")) == "/Sig" or (str(obj.get("/FT", "")) == "/Sig" and obj.get("/V") is not None):
                        fail("SIGNED_PDF", "This PDF already contains a digital signature. Use the unsigned original.")
                        return
            output = io.BytesIO()
            pdf.save(output, encryption=False)
            result = output.getvalue()
            if len(result) > 30 * 1024 * 1024:
                fail("FILE_LIMIT", "The editable copy exceeds the 30 MB limit.")
                return
            print(json.dumps({"ok": True, "base64": base64.b64encode(result).decode("ascii")}))
    except pikepdf.PasswordError:
        fail("PASSWORD_REQUIRED" if not request.get("password") else "WRONG_PASSWORD", "Enter the PDF opening password." if not request.get("password") else "That password did not open this PDF.")
    except Exception:
        fail("UNREADABLE_PDF", "This PDF could not be opened. Try a fresh copy from the original app.")


if __name__ == "__main__":
    main()
