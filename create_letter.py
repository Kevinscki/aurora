from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Header
header = doc.add_paragraph()
header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
run = header.add_run("Doc\n[Your Address]\n[Your Phone Number]\n[Your Email]")
run.font.size = Pt(11)

doc.add_paragraph("\n[Date]\n")

# Recipient
recipient = doc.add_paragraph()
recipient.add_run("Hiring Manager\nMentor of America\n[Company Address]")

doc.add_paragraph("\nDear Hiring Manager,\n")

# Body
body = [
    "I am writing to formally express my interest in the Mentor position at Mentor of America. With extensive experience in the field of marketing, I have spent years developing strategies that drive growth, build brand loyalty, and communicate complex ideas effectively. I am now eager to transition these professional strengths into a mentorship role where I can empower others to achieve their full potential.",
    "Throughout my career in marketing, I have learned that success is not just about the right strategy, but about the people executing it. I have consistently found fulfillment in guiding junior team members, simplifying complex marketing concepts, and helping others navigate the challenges of a competitive professional landscape. My background has equipped me with the patience, communication skills, and strategic mindset necessary to be an impactful mentor.",
    "I am drawn to Mentor of America because of your commitment to guidance and development. I believe that my deep industry knowledge, combined with my passion for helping others grow, makes me an ideal candidate to support your mission. I am confident that I can provide the practical insights and encouragement your mentees need to excel.",
    "Thank you for your time and consideration. I look forward to the possibility of discussing how my marketing expertise and leadership experience can benefit the Mentor of America community."
]

for para in body:
    p = doc.add_paragraph(para)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

# Closing
closing = doc.add_paragraph("\nSincerely,\n\n\nDoc")
closing.alignment = WD_ALIGN_PARAGRAPH.LEFT

doc.save("documents/Application_Letter_Mentor_of_America.docx")
