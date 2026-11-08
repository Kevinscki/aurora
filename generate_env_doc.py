from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

def create_doc():
    doc = Document()

    # Title
    title = doc.add_heading('Environmental Conservation: A Path to Sustainability', 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # Introduction
    doc.add_heading('Introduction', level=1)
    doc.add_paragraph(
        "Environmental conservation is the practice of protecting the natural environment on individual, "
        "organizational, and governmental levels. It involves the sustainable management of natural resources "
        "to prevent exploitation, destruction, and neglect of the Earth's ecosystems."
    )

    # Key Pillars
    doc.add_heading('Key Pillars of Conservation', level=1)
    
    pillars = {
        "Biodiversity Protection": "Preserving the variety of life on Earth, including endangered species and their habitats, to maintain ecological balance.",
        "Sustainable Resource Management": "Using renewable resources (like timber and water) at a rate that allows them to regenerate naturally.",
        "Pollution Reduction": "Reducing the emission of greenhouse gases, eliminating single-use plastics, and cleaning up water bodies.",
        "Reforestation and Afforestation": "Planting trees to restore lost forests, which act as critical carbon sinks and habitats for wildlife."
    }

    for pillar, description in pillars.items():
        p = doc.add_paragraph(style='List Bullet')
        run = p.add_run(f"{pillar}: ")
        run.bold = True
        p.add_run(description)

    # Individual Actions
    doc.add_heading('What Individuals Can Do', level=1)
    actions = [
        "Adopt the 3 Rs: Reduce, Reuse, and Recycle.",
        "Transition to renewable energy sources where possible.",
        "Support sustainable and ethical brands.",
        "Reduce water consumption in daily activities.",
        "Educate others about the importance of ecology."
    ]
    for action in actions:
        doc.add_paragraph(action, style='List Bullet')

    # Conclusion
    doc.add_heading('Conclusion', level=1)
    doc.add_paragraph(
        "The health of our planet is inextricably linked to the health of humanity. By implementing "
        "conservation strategies today, we ensure a livable, vibrant world for future generations."
    )

    doc.save('Environmental_Conservation.docx')

if __name__ == "__main__":
    create_doc()
