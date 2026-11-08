import subprocess
import datetime
import os

def get_command_output(command):
    try:
        return subprocess.check_output(command, shell=True, stderr=subprocess.STDOUT).decode('utf-8').strip()
    except subprocess.CalledProcessError as e:
        return f"Error executing command: {e.output.decode('utf-8')}"

def run_health_check():
    report_date = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report_path = "./ai_reports/system_health_report.txt"
    
    # 1. Disk Usage (Root partition)
    disk_usage = get_command_output("df -h / | awk 'NR==2 {print $5}'")
    disk_percent = int(disk_usage.replace('%', ''))
    disk_status = "OK" if disk_percent < 80 else "WARNING"

    # 2. Memory Usage
    mem_info = get_command_output("free -m | awk 'NR==2 {printf \"Used: %sMB / Total: %sMB (%.2f%%)\", $3, $2, $3*100/$2}'")

    # 3. CPU Load (1, 5, 15 min averages)
    cpu_load = get_command_output("uptime | awk -F'load average: ' '{print $2}'")

    # 4. Top 5 Memory Consuming Processes
    top_processes = get_command_output("ps aux --sort=-%mem | awk 'NR<=6 {print $1, $2, $4, $11}' | column -t")

    # Construct Report
    report_content = f"""==================================================
SYSTEM HEALTH REPORT
Generated: {report_date}
==================================================

DISK USAGE (Root): {disk_usage} [{disk_status}]
MEMORY USAGE:     {mem_info}
CPU LOAD AVG:     {cpu_load}

TOP 5 MEMORY PROCESSES:
USER PID %MEM COMMAND
--------------------------------------------------
{top_processes}
==================================================
"""
    
    with open(report_path, "w") as f:
        f.write(report_content)
    
    return report_path

if __name__ == "__main__":
    path = run_health_check()
    print(f"Health check completed. Report saved to: {path}")
