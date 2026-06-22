import re
import urllib.request
import ssl
import json
import os
from html.parser import HTMLParser

# Helper to bypass SSL verification if needed
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

class TablePressParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.current_table = None
        self.current_row = None
        self.in_thead = False
        self.in_tbody = False
        self.in_th = False
        self.in_td = False
        self.cell_content = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "table":
            if "tablepress" in attrs_dict.get("class", ""):
                self.current_table = {
                    "id": attrs_dict.get("id", ""),
                    "headers": [],
                    "rows": []
                }
        elif self.current_table is not None:
            if tag == "thead":
                self.in_thead = True
            elif tag == "tbody":
                self.in_tbody = True
            elif tag == "tr":
                self.current_row = []
            elif tag == "th":
                self.in_th = True
                self.cell_content = []
            elif tag == "td":
                self.in_td = True
                self.cell_content = []
            elif tag == "br":
                # Save a newline placeholder to split on line breaks inside cells
                self.cell_content.append("\n")

    def handle_endtag(self, tag):
        if tag == "table" and self.current_table is not None:
            self.tables.append(self.current_table)
            self.current_table = None
        elif self.current_table is not None:
            if tag == "thead":
                self.in_thead = False
            elif tag == "tbody":
                self.in_tbody = False
            elif tag == "tr" and self.current_row is not None:
                if self.in_tbody:
                    self.current_table["rows"].append(self.current_row)
                self.current_row = None
            elif tag == "th":
                self.in_th = False
                text = "".join(self.cell_content).strip()
                self.current_table["headers"].append(text)
            elif tag == "td":
                self.in_td = False
                text = "".join(self.cell_content).strip()
                self.current_row.append(text)

    def handle_data(self, data):
        if self.current_table is not None:
            if self.in_th or self.in_td:
                self.cell_content.append(data)

def split_places(text):
    # Normalize whitespaces
    text = re.sub(r'[ \t\r\f]+', ' ', text)
    # Remove whitespace around slashes (e.g. "A / B" -> "A/B")
    text = re.sub(r'\s*/\s*', '/', text)
    # Split by comma or newline
    parts = re.split(r'[\n,]', text)
    cleaned = []
    for p in parts:
        p_clean = p.strip()
        # Replace multiple spaces with a single space
        p_clean = re.sub(r'\s+', ' ', p_clean)
        # Clean weird encoding/quotes (e.g. replace smart quotes, replace \ufffd with ')
        p_clean = p_clean.replace("\ufffd", "'").replace("’", "'").replace("‘", "'").replace("`", "'").replace("“", "'").replace("”", "'")
        if p_clean:
            cleaned.append(p_clean)
    return cleaned

def main():
    url = "https://www.buscor.co.za/tariffs/"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    html = ""
    # Try fetching first
    print("Fetching Buscor tariffs page...")
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, context=ctx) as response:
            html = response.read().decode('utf-8', errors='ignore')
        print(f"Successfully fetched online data ({len(html)} bytes).")
    except Exception as e:
        print(f"Could not fetch online tariffs ({e}). Trying to load from local raw_tariffs.html fallback...")
        # Check if local file exists
        if os.path.exists("raw_tariffs.html"):
            with open("raw_tariffs.html", "r", encoding="utf-8") as f:
                html = f.read()
            print("Loaded raw_tariffs.html successfully.")
        else:
            # Check scratch path fallback
            scratch_path = r"C:\Users\DELL\.gemini\antigravity-ide\brain\fe154e20-4456-433c-961e-38e7055e92b5\scratch\raw_tariffs.html"
            if os.path.exists(scratch_path):
                with open(scratch_path, "r", encoding="utf-8") as f:
                    html = f.read()
                print("Loaded raw_tariffs.html from scratch folder successfully.")
            else:
                print("Error: No raw tariffs source found.")
                return

    parser = TablePressParser()
    parser.feed(html)

    table_areas = {
        "tablepress-32": "Nelspruit Area",
        "tablepress-27": "White River Area",
        "tablepress-40": "Malalane Area"
    }

    expanded_trips = []

    for table in parser.tables:
        tid = table["id"]
        area = table_areas.get(tid)
        if not area:
            # Skip non-target tables
            continue
            
        print(f"\nProcessing {area} ({tid})...")
        for r_idx, row in enumerate(table["rows"]):
            if len(row) < 4:
                continue
            
            from_val = row[0]
            to_val = row[1]
            ticket_type_val = row[2]
            new_tariff_val = row[3]
            cash_tariff_val = row[4] if len(row) > 4 else ""
            
            # Split locations
            from_places = split_places(from_val)
            to_places = split_places(to_val)
            
            # Split ticket types & new tariffs (by slash or newline)
            raw_types = [t.strip() for t in re.split(r'[\n/]', ticket_type_val) if t.strip()]
            raw_prices = [p.strip() for p in re.split(r'[\n/]', new_tariff_val) if p.strip()]
            prices = [p.replace("R", "").strip() for p in raw_prices if p.strip()]
            
            # Parse cash tariff
            cash_price = cash_tariff_val.replace("R", "").strip()
            cash_price = re.sub(r'[\s\n/]', '', cash_price)
            
            # Expand combinations
            for f_place in from_places:
                for t_place in to_places:
                    # Multi-day ticket options
                    for t_type, price in zip(raw_types, prices):
                        expanded_trips.append({
                            "area": area,
                            "from": f_place,
                            "to": t_place,
                            "ticketType": t_type,
                            "price": f"R{price}"
                        })
                    # Cash option
                    if cash_price:
                        expanded_trips.append({
                            "area": area,
                            "from": f_place,
                            "to": t_place,
                            "ticketType": "Single / Cash",
                            "price": f"R{cash_price}"
                        })

    print(f"\nTotal expanded trips parsed: {len(expanded_trips)}")
    
    # Save as JSON file
    json_path = "trips.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(expanded_trips, f, indent=2, ensure_ascii=False)
    print(f"Saved expanded trips to: {os.path.abspath(json_path)}")

    # Save as generatedTrips.js
    js_path = "generatedTrips.js"
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("const trips = ")
        json.dump(expanded_trips, f, indent=2, ensure_ascii=False)
        f.write(";\n\nif (typeof module !== 'undefined' && module.exports) {\n  module.exports = trips;\n}\n")
    print(f"Saved expanded trips to: {os.path.abspath(js_path)}")

if __name__ == "__main__":
    main()
