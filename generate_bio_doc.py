from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

def create_doc():
    doc = Document()

    # Title
    title = doc.add_heading('Biodiversity and Species Conservation', 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # Introduction
    doc.add_heading('What is Biodiversity?', level=1)
    doc.add_paragraph(
        "Biodiversity refers to the variety of all living things on Earth—from the smallest bacteria "
        "to the largest whales. It encompasses genetic diversity within species, the variety of "
        "species themselves, and the complex ecosystems they form."
    )

    # Importance
    doc.add_heading('Why Species Conservation Matters', level=1)
    importance = [
        "Ecosystem Stability: Diverse ecosystems are more resilient to disasters and climate change.",
        "Medicine and Science: Many life-saving drugs are derived from rare plant and animal species.",
        "Pollination and Food Security: Bees, birds, and bats are essential for the pollination of crops.",
        "Water and Air Purification: Forests and wetlands filter pollutants from our air and water."
    ]
    for item in importance:
        doc.add_paragraph(item, style='List Bullet')

    # Threats
    doc.add_heading('Threats to Global Species', level=1)
    threats = {
        "Habitat Loss": "Deforestation and urban expansion destroying natural homes.",
        "Climate Change": "Rapid temperature shifts forcing species to migrate or face extinction.",
        "Overexploitation": "Overfishing and illegal poaching of endangered wildlife.",
        "Invasive Species": "Non-native species disrupting local food chains and ecosystems."
    }
    for threat, desc in threats.items():
        p = doc.add_paragraph(style='List Bullet')
        run = p.add_run(f"{threat}: ")
        run.bold = True
        p.add_run(desc)

    # Conservation Strategies
    doc.add_heading('How to Take Care of Species', level=1)
    strategies = [
        "Establishing Protected Areas: Creating national parks and wildlife sanctuaries.",
        "Captive Breeding Programs: Helping endangered species recover in controlled environments before release.",
        "Legislative Protection: Enforcing laws like the CITES treaty to stop illegal wildlife trade.",
        "Restoring Habitats: Replanting native vegetation and cleaning up coral reefs."
    ]
    for strategy in strategies:
        doc.add_paragraph(strategy, style='List Bullet')

    # Conclusion
    doc.add_heading('Conclusion', level=1)
    doc.add_paragraph(
        "Protecting biodiversity is not just about saving a single animal; it is about preserving "
        "the intricate web of life that supports human existence. Every species plays a role, "
        "and every effort to conserve them is an investment in our own survival."
    )

    doc.save('Biodiversity_Conservation.docx')

if __name__ == "__main__":
    create_doc()
