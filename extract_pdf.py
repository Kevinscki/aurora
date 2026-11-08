import PyPDF2
import os

path = "/home/kelvin/Downloads/KelvinRutatinaCVProgressReport.pdf"
try:
    with open(path, 'rb') as f:
        reader = PyPDF2.PdfReader(f)
        text = ""
        for page in reader.pages:
            text += page.extract_text() + "\n"
        print(text)
except Exception as e:
    print(f"Error: {e}")
